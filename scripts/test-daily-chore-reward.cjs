const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
const worker=fs.readFileSync('src/worker.js','utf8');
test('daily chore reward is all-or-nothing',()=>{assert.match(html,/function choreDayReady/);assert.match(html,/exempt_approved/);assert.match(html,/choreDailyAmount/);assert.match(worker,/전체 완료 조건 미충족/)});
test('daily reward is parent-only and paid through server',()=>{assert.match(worker,/api\/chores\/daily\/review/);assert.match(worker,/if\(!me\.is_admin\)/);assert.match(html,/api\/chores\/daily\/review/);assert.match(worker,/daily_chore_reward/);assert.match(worker,/일일 할 일 보상은 부모 승인 API에서만/)});
test('old per-item payment path is disabled',()=>{assert.match(html,/개별 할 일 보상 지급이 비활성화되었습니다/);assert.doesNotMatch(html,/await creditChoreReward\(/)});
test('daily requests sync and approvals are grouped',()=>{assert.match(html,/chore_daily_requests:'gyeongjin_chore_daily_requests'/);assert.match(html,/할 일 완료 요청/);assert.match(html,/choreDailyDetail/);assert.match(worker,/chore_daily_requests/)});

test('pending exemptions are visible before daily reward submission',()=>{assert.match(html,/const exemptionRows=/);assert.match(html,/exemptionRows\.length/);assert.match(html,/exempt_requested/)});

test('exemption reviews require a parent and use CAS',()=>{assert.match(worker,/api\/chores\/exemption\/review/);assert.match(html,/api\/chores\/exemption\/review/);assert.match(worker,/면제 요청 없음/);assert.match(worker,/동시 수정 충돌/)});

test('daily estimated reward is prominently displayed',()=>{assert.match(html,/오늘의 예상 일일 보상/);assert.match(html,/chore-reward-preview/);assert.match(html,/부모 승인 후 확정/)});

test('parent can reverse approved daily payout without deleting original entry',()=>{assert.match(worker,/api\/chores\/daily\/reverse/);assert.match(worker,/daily_chore_reward_reversal/);assert.match(worker,/reversalReason/);assert.match(worker,/abs\(-9223372036854775808\)/);assert.match(html,/reverseChoreDay/);assert.match(html,/할 일 승인 이력/);assert.match(html,/choreApprovalHistory/);assert.match(html,/잘못 승인했어요/)});

test('legacy reward correction preserves the original and adds an idempotent expense',()=>{assert.match(worker,/api\/chores\/legacy\/reverse/);assert.match(worker,/legacy_chore_reward_reversal/);assert.match(worker,/originalAmount/);assert.match(worker,/reverses:b\.id/);assert.match(html,/정정 내역/);assert.match(html,/reverseLegacyChore/)});

test('approved exemptions count toward completion but never pay',()=>{assert.match(html,/\['done','exempt_approved'\]\.includes/);assert.match(html,/x\.dayRecord\?\.state==='exempt_approved'\?0/);assert.match(worker,/x\.dayRecords\?\.\[date\]\?\.state==="exempt_approved"\?0/);assert.match(html,/면제는 달성률에 포함하되 보상금 제외/)});
