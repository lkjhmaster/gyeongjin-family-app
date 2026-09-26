import { withSupabase } from "npm:@supabase/server@^1";

export default {
  fetch: withSupabase(
    { auth: "user" },
    async (req, ctx) => {
      try {
        const userId = ctx.userClaims?.id;

        if (!userId) {
          return Response.json(
            { ok: false, message: "로그인이 필요합니다." },
            { status: 401 },
          );
        }

        // 현재 로그인한 사용자가 부모인지 확인
        const { data: profile, error: profileError } =
          await ctx.supabaseAdmin
            .from("app_profiles")
            .select("user_id, role, active, display_name")
            .eq("user_id", userId)
            .maybeSingle();

        if (profileError) {
          return Response.json(
            { ok: false, message: profileError.message },
            { status: 500 },
          );
        }

        if (
          !profile ||
          profile.role !== "parent" ||
          profile.active !== true
        ) {
          return Response.json(
            {
              ok: false,
              message: "부모 계정만 사용할 수 있는 기능입니다.",
            },
            { status: 403 },
          );
        }

        let body: Record<string, unknown> = {};

        try {
          body = await req.json();
        } catch {
          return Response.json(
            { ok: false, message: "요청 형식이 올바르지 않습니다." },
            { status: 400 },
          );
        }

        const action = String(body.action ?? "");

        // --------------------------------------------------
        // 자녀 목록 조회
        // --------------------------------------------------
        if (action === "list_children") {
          const { data, error } = await ctx.supabaseAdmin
            .from("allowance_children")
            .select("id, name, login_id, user_id, active")
            .order("created_at", { ascending: true });

          if (error) {
            return Response.json(
              { ok: false, message: error.message },
              { status: 500 },
            );
          }

          return Response.json({
            ok: true,
            children: data ?? [],
          });
        }

        // --------------------------------------------------
        // 자녀 계정 생성 / 연결
        // --------------------------------------------------
        if (action === "create_child") {
          const childId = String(body.child_id ?? "").trim();
          const loginId = String(body.login_id ?? "").trim().toLowerCase();
          const password = String(body.password ?? "");

          if (!childId || !loginId || !password) {
            return Response.json(
              {
                ok: false,
                message: "자녀, 로그인 ID, 비밀번호를 모두 입력해주세요.",
              },
              { status: 400 },
            );
          }

          // 로그인 ID는 내부 이메일 생성에 사용하므로
          // 영문 소문자 / 숫자 / . _ - 만 허용
          if (!/^[a-z0-9._-]+$/.test(loginId)) {
            return Response.json(
              {
                ok: false,
                message:
                  "자녀 로그인 ID는 영문 소문자, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
              },
              { status: 400 },
            );
          }

          if (!/^\d{4}$/.test(password)) {
            return Response.json(
              {
                ok: false,
                message: "자녀 비밀번호는 4자리 숫자로 입력해주세요.",
              },
              { status: 400 },
            );
          }

          // 자녀 정보 확인
          const { data: child, error: childError } =
            await ctx.supabaseAdmin
              .from("allowance_children")
              .select("id, name, user_id, login_id, active")
              .eq("id", childId)
              .maybeSingle();

          if (childError) {
            return Response.json(
              { ok: false, message: childError.message },
              { status: 500 },
            );
          }

          if (!child) {
            return Response.json(
              { ok: false, message: "해당 자녀 정보를 찾을 수 없습니다." },
              { status: 404 },
            );
          }

          // 다른 자녀가 같은 로그인 ID를 사용하는지 확인
          const { data: duplicate } = await ctx.supabaseAdmin
            .from("allowance_children")
            .select("id, name")
            .eq("login_id", loginId)
            .neq("id", childId)
            .maybeSingle();

          if (duplicate) {
            return Response.json(
              {
                ok: false,
                message: `이미 다른 자녀가 사용 중인 로그인 ID입니다: ${loginId}`,
              },
              { status: 409 },
            );
          }

          const internalEmail =
            `${loginId}@child.gyeongjin-budget.local`;

          let authUserId = child.user_id;

          // 아직 Auth 계정이 없으면 새로 생성
          if (!authUserId) {
            const {
              data: created,
              error: createError,
            } = await ctx.supabaseAdmin.auth.admin.createUser({
              email: internalEmail,
              password: `GJCHILD:${password}`,
              email_confirm: true,
            });

            if (createError || !created.user) {
              return Response.json(
                {
                  ok: false,
                  message:
                    createError?.message ??
                    "자녀 계정을 만들지 못했습니다.",
                },
                { status: 500 },
              );
            }

            authUserId = created.user.id;
          } else {
            // 기존 Auth 계정이 있으면 비밀번호와 이메일을 갱신
            const { error: updateAuthError } =
              await ctx.supabaseAdmin.auth.admin.updateUserById(
                authUserId,
                {
                  email: internalEmail,
                  password: `GJCHILD:${password}`,
                  email_confirm: true,
                },
              );

            if (updateAuthError) {
              return Response.json(
                {
                  ok: false,
                  message: updateAuthError.message,
                },
                { status: 500 },
              );
            }
          }

          // 자녀 계정 정보 연결
          const { error: childUpdateError } =
            await ctx.supabaseAdmin
              .from("allowance_children")
              .update({
                user_id: authUserId,
                login_id: loginId,
                active: true,
                updated_at: new Date().toISOString(),
              })
              .eq("id", childId);

          if (childUpdateError) {
            return Response.json(
              {
                ok: false,
                message: childUpdateError.message,
              },
              { status: 500 },
            );
          }

          // 앱 프로필 생성/갱신
          const { error: profileUpsertError } =
            await ctx.supabaseAdmin
              .from("app_profiles")
              .upsert(
                {
                  user_id: authUserId,
                  role: "child",
                  display_name: child.name,
                  login_id: loginId,
                  active: true,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "user_id" },
              );

          if (profileUpsertError) {
            return Response.json(
              {
                ok: false,
                message: profileUpsertError.message,
              },
              { status: 500 },
            );
          }

          return Response.json({
            ok: true,
            message: "자녀 계정이 저장되었습니다.",
          });
        }

        // --------------------------------------------------
        // 자녀 로그인 ID 변경
        // --------------------------------------------------
        if (action === "set_login_id") {
          const childId = String(body.child_id ?? "").trim();
          const loginId = String(body.login_id ?? "").trim().toLowerCase();

          if (!childId || !loginId) {
            return Response.json(
              {
                ok: false,
                message: "자녀와 새 로그인 ID를 입력해주세요.",
              },
              { status: 400 },
            );
          }

          // 로그인 ID는 내부 이메일 생성에 사용하므로
          // 영문 소문자 / 숫자 / . _ - 만 허용
          if (!/^[a-z0-9._-]+$/.test(loginId)) {
            return Response.json(
              {
                ok: false,
                message:
                  "자녀 로그인 ID는 영문 소문자, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
              },
              { status: 400 },
            );
          }

          // 자녀 정보 확인
          const { data: child, error: childError } =
            await ctx.supabaseAdmin
              .from("allowance_children")
              .select("id, name, user_id, login_id, active")
              .eq("id", childId)
              .maybeSingle();

          if (childError) {
            return Response.json(
              { ok: false, message: childError.message },
              { status: 500 },
            );
          }

          if (!child) {
            return Response.json(
              { ok: false, message: "해당 자녀 정보를 찾을 수 없습니다." },
              { status: 404 },
            );
          }

          if (!child.user_id) {
            return Response.json(
              {
                ok: false,
                message: "먼저 자녀 계정을 만들어주세요.",
              },
              { status: 404 },
            );
          }

          // 다른 자녀가 같은 로그인 ID를 사용하는지 확인
          const { data: duplicate, error: duplicateError } =
            await ctx.supabaseAdmin
              .from("allowance_children")
              .select("id, name")
              .eq("login_id", loginId)
              .neq("id", childId)
              .maybeSingle();

          if (duplicateError) {
            return Response.json(
              { ok: false, message: duplicateError.message },
              { status: 500 },
            );
          }

          if (duplicate) {
            return Response.json(
              {
                ok: false,
                message: `이미 다른 자녀가 사용 중인 로그인 ID입니다: ${loginId}`,
              },
              { status: 409 },
            );
          }

          const internalEmail =
            `${loginId}@child.gyeongjin-budget.local`;

          // 실제 Supabase Auth 로그인 이메일 변경
          const { error: updateAuthError } =
            await ctx.supabaseAdmin.auth.admin.updateUserById(
              child.user_id,
              {
                email: internalEmail,
                email_confirm: true,
              },
            );

          if (updateAuthError) {
            return Response.json(
              {
                ok: false,
                message: updateAuthError.message,
              },
              { status: 500 },
            );
          }

          // 자녀 테이블의 로그인 ID도 변경
          const { error: childUpdateError } =
            await ctx.supabaseAdmin
              .from("allowance_children")
              .update({
                login_id: loginId,
                updated_at: new Date().toISOString(),
              })
              .eq("id", childId);

          if (childUpdateError) {
            return Response.json(
              {
                ok: false,
                message:
                  `인증 계정은 변경되었지만 자녀 정보 저장에 실패했습니다: ${childUpdateError.message}`,
              },
              { status: 500 },
            );
          }

          // 앱 프로필의 로그인 ID도 동기화
          const { error: profileUpdateError } =
            await ctx.supabaseAdmin
              .from("app_profiles")
              .update({
                login_id: loginId,
                updated_at: new Date().toISOString(),
              })
              .eq("user_id", child.user_id);

          if (profileUpdateError) {
            return Response.json(
              {
                ok: false,
                message:
                  `로그인 ID는 변경되었지만 프로필 동기화에 실패했습니다: ${profileUpdateError.message}`,
              },
              { status: 500 },
            );
          }

          return Response.json({
            ok: true,
            message: `자녀 로그인 ID가 ${loginId}(으)로 변경되었습니다.`,
            login_id: loginId,
          });
        }

        // --------------------------------------------------
        // 자녀 비밀번호 변경
        // --------------------------------------------------
        if (action === "set_password") {
          const childId = String(body.child_id ?? "").trim();
          const password = String(body.password ?? "");

          if (!childId || !password) {
            return Response.json(
              {
                ok: false,
                message: "자녀와 새 비밀번호를 입력해주세요.",
              },
              { status: 400 },
            );
          }

          if (!/^\d{4}$/.test(password)) {
            return Response.json(
              {
                ok: false,
                message: "자녀 비밀번호는 4자리 숫자로 입력해주세요.",
              },
              { status: 400 },
            );
          }

          const { data: child, error: childError } =
            await ctx.supabaseAdmin
              .from("allowance_children")
              .select("id, user_id, login_id")
              .eq("id", childId)
              .maybeSingle();

          if (childError) {
            return Response.json(
              { ok: false, message: childError.message },
              { status: 500 },
            );
          }

          if (!child || !child.user_id) {
            return Response.json(
              {
                ok: false,
                message: "먼저 자녀 계정을 만들어주세요.",
              },
              { status: 404 },
            );
          }

          const loginId = String(child.login_id ?? "")
            .trim()
            .toLowerCase();

          if (!loginId) {
            return Response.json(
              {
                ok: false,
                message: "자녀 로그인 ID가 설정되어 있지 않습니다.",
              },
              { status: 400 },
            );
          }

          const internalEmail =
            `${loginId}@child.gyeongjin-budget.local`;

          const { error: updateError } =
            await ctx.supabaseAdmin.auth.admin.updateUserById(
              child.user_id,
              {
                email: internalEmail,
                password: `GJCHILD:${password}`,
                email_confirm: true,
              },
            );

          if (updateError) {
            return Response.json(
              {
                ok: false,
                message: updateError.message,
              },
              { status: 500 },
            );
          }

          return Response.json({
            ok: true,
            message: "자녀 비밀번호가 변경되었습니다.",
          });
        }

        return Response.json(
          {
            ok: false,
            message: "알 수 없는 요청입니다.",
          },
          { status: 400 },
        );
      } catch (error) {
        return Response.json(
          {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "서버 오류가 발생했습니다.",
          },
          { status: 500 },
        );
      }
    },
  ),
};