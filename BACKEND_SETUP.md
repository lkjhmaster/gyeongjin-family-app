# 경진훈주시라 공용 백엔드

Cloudflare Workers + D1 기반 무료 우선 구조입니다.

## 준비된 기능
- 최초 부모 관리자 생성
- 가족 구성원 로그인 세션 기반
- 가족 단위 공용 상태 저장 API
- 일정, 월간 메모, 가족시간, 추억, 구성원 사진첩 저장 키
- 비밀번호는 평문으로 저장하지 않음
- 세션 토큰도 원문으로 DB에 저장하지 않음

## Cloudflare에서 필요한 최초 1회 작업
1. D1 데이터베이스 `gyeongjin-family-db` 생성
2. 최초 생성한 database_id를 `wrangler.api.jsonc`에 입력 (현재 기존 DB ID 설정 완료; 재생성 금지)
3. `schema.sql`을 D1에 적용
4. Worker를 `wrangler.api.jsonc` 설정으로 배포

## 현재 자동 배포 및 검증
- `wrangler.json`: 정적 PWA, `gyeongjin-family-app.muse-hooni.workers.dev`.
- `wrangler.api.jsonc`: `src/worker.js` API, 기존 `DB` D1 바인딩, 기존 정기 작업 설정.
- 검증 성공 후 API를 먼저 배포하고 `/api/health`에서 커밋 해시, D1 읽기, 변제 취소 기능, 두 기존 화면 주소의 CORS를 확인한 다음 PWA를 배포합니다.
- `/api/health`는 가족 테이블을 읽기만 하며 데이터나 잔고를 변경하지 않습니다. DB 연결 실패는 503입니다.
- `node --test scripts/test-repayment.mjs`: 독립된 메모리 SQLite에서 잔고 복원, 중복 취소, 권한, 연결 불일치, 동시 변경 및 화면 연동 검증.
- `node scripts/check-deployed-api.mjs`: 운영 읽기 전용 확인. `EXPECTED_RELEASE` 지정 시 해당 커밋과 일치해야 통과합니다.
- 자동 배포는 DB 생성, 스키마 적용, 데이터 이동·초기화 작업을 실행하지 않습니다.
- 취소는 기존 내역을 삭제하지 않고 연결 거래 모두를 `cancelled`로 보존합니다. 실제 가족 거래 취소는 부모 관리자가 화면에서 명시적으로 실행합니다.

기존 Pages 화면과 Workers 화면은 같은 API를 사용하며 두 기존 주소만 CORS에 허용합니다. 기존 localStorage와 D1 데이터를 보존합니다.
