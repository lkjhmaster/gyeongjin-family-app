# 자녀 간 거래 시스템 구현 명세 (2026-10-18)

상태: 서버·화면 구현 및 실제 SQLite·데스크톱 브라우저 테스트 완료. 배포 성공 여부는 GitHub Actions와 실제 서비스의 릴리스 식별자로 별도 확인한다. 기존 데이터/승인/용돈 정산을 보존한다.

## 확정 정책
- 유형: 차용자 신청 대여, 지정 상대방 간 물품 직거래.
- 양 당사자 동의 및 부모 승인. 부모 승인함 통합. 모든 변경 감사 기록.
- 자유/카드/마이너스 용돈 사용. 기존 용돈 종류별 이동 수수료율을 동일 적용하며 거래 자체 수수료 없음. 보내는 사람 부담. 거래 확인 전 총 출금, 수수료, 실수령액 명시.
- 대여는 부모 승인 시 원자적으로 즉시 지급 및 실수령액을 채무 원금으로 기록. 상환은 일부/전액 가능하고 대여자의 실제 수령액만큼 원금 감소. 상환기한 선택; 연체 알림만, 자동 차감 없음. 미상환 채무가 있으면 모든 상대방에 대한 신규 차용 제한.
- 물품은 부모 승인 시 수수료 포함 출금 예정액 예약(실제 지출 미반영). 양측 물품 전달 확인 후 단 한 번 정산. 판매자가 수령 용돈 지정. 예약은 완료/취소까지 유지.
- 잔액/마이너스 한도 부족 시 승인 거절; 자동 만료 없음.
- 승인 전 취소 자유; 승인 후 양측 협의 및 부모 승인. 전액/부분 환불 시 원거래 수수료 비례 복원. 승인 후 조건 변경 시 양측 재동의·부모 재승인. 분쟁 시 미정산 금액 지급 보류, 부모 조정. 정정은 원거래 보존 및 보정 분개.
- 화면: 용돈기입장 내부, 채권/채무 요약, 최근 거래, 진행중/완료/취소 탭. 달력에 거래 표시 및 상세보기, 앱 내부 알림, 전체 이력 보관.

## 권장 데이터 모델 (구현 전 실제 백엔드 스키마와 대조)
transactions(id,kind,requester_id,counterparty_id,payer_id,payee_id,source_wallet,destination_wallet,gross_amount,fee_amount,net_amount,status,revision,created_at,updated_at)
approvals(id,transaction_id,revision,actor_id,decision,created_at)
holds(id,transaction_id,wallet_owner_id,wallet,amount,status,created_at,released_at)
postings(id,transaction_id,posting_kind,owner_id,wallet,amount,original_posting_id,created_at)
loans(id,transaction_id,principal_amount,outstanding_amount,due_date,status)
repayments(id,loan_id,transaction_id,gross_amount,fee_amount,net_principal_reduction,created_at)
audit_events(id,transaction_id,actor_id,action,previous_state,next_state,created_at)

## 안전성 불변식
1. 서버에서 거래 상태와 승인 권한을 검증한다. 클라이언트 저장값은 권한/잔액의 신뢰원으로 사용하지 않는다.
2. 승인·정산·환불은 서버 트랜잭션으로 원자 처리. transaction_id + revision + action 단위 멱등키 적용.
3. 사용가능금액 = 실제 사용가능금액 - 활성 예약금. 마이너스는 잔여 한도를 기준으로 검증.
4. 부모 승인 전 상대방 동의가 필수이며, 변경된 revision의 이전 동의/승인은 재사용 금지.
5. 대여원금과 상환감소액은 각각 실수령액 기준. 상환액은 남은 원금을 초과할 수 없음.
6. 원거래 분개는 불변; 환불/정정은 참조 분개를 추가하며 누적 환불액은 원거래를 초과할 수 없음.
7. 완료/취소/분쟁 상태는 감사 기록으로 남기고 자정 경과로 요청이 소실되지 않도록 한다.
8. 달력 합계는 확정 posting만 집계하고 예약/요청/취소분을 중복 집계하지 않는다.

## 구현 전 해결할 상세사항
- 판매대금의 마이너스 수령은 현금입금이 아니라 사용액 변제 처리; 초과분 처리와 기존 카드→마이너스 수수료 정산과 일치시키기.
- 부분 환불 시 회수 잔액 부족은 자동 마이너스 발생 없이 부모 조정 상태로 전환.
- 이미 정산된 대여의 승인 후 조건변경은 취소·반환/정정 흐름으로만 처리.
- 동시 승인, 자정 경과, 중복 요청, 부족 잔액, 환불 및 달력 합계 회귀 테스트.

## 배포 게이트
실제 서버 API 및 D1/스토리지 구조 확인 → 스키마 호환 마이그레이션 설계 → 코드 구현 → 문법/빌드/단위·회귀 테스트 → GitHub 커밋 → Cloudflare 배포 결과 확인 → 모바일 실기기 검증(사용자).

