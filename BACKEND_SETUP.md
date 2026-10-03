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
2. 반환된 database_id를 `wrangler.api.jsonc`의 `REPLACE_WITH_D1_DATABASE_ID`에 입력
3. `schema.sql`을 D1에 적용
4. Worker를 `wrangler.api.jsonc` 설정으로 배포

이 단계 이후 프런트엔드의 기존 localStorage 데이터를 API와 동기화합니다.

중요: 기존 Pages 앱과 기존 localStorage 데이터는 현재 그대로 유지됩니다. 백엔드가 준비되기 전에는 기존 가족앱 동작에 영향을 주지 않습니다.
