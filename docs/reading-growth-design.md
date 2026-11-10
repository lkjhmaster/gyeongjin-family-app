# 독서성장 1단계 설계 (초안)

대상: 초등 고학년, 중2. 막내는 이번 범위에서 제외.
원칙: 한 번 입력하고 재사용, 부족한 부분만 질문, 짧게 나눠 자동저장, 아이 표현 보존, 성취 피드백.
모든 기록은 덮어쓰지 않고 쌓는다(append-only).

## 단계
1. 기록·독후활동·독후감·임시저장·부모 피드백 (질문은 질문 은행)
2. AI 후속 질문 (Workers AI 무료 한도, 실패 시 질문 은행으로 대체)
3. 보상 연동 (로그인 보안 강화 후, 부모 승인 시에만 지급)

## 새 표 (모두 추가 전용, 기존 표 변경 없음)
- reading_books(id, family_id, child_id, title, author, started_at, status[reading|writing|review|done], created_at)
- reading_answers(id, book_id, step[intro|why1|why2|why3|...], prompt_id, answer, version, created_at) — 수정 시 새 version 행 추가
- reading_essays(id, book_id, version, kind[draft|revision|final], body, created_at)
- reading_feedback(id, book_id, essay_version, parent_id, praise, improve, question_json, created_at)

보상(3단계)은 reading_rewards(book_id, child_id, stage, UNIQUE(book_id, child_id, stage))로 중복 지급을 막는다.

## 화면 흐름
책 등록 → 독후활동(질문 3~5개, 짧게, 자동저장, 이어쓰기) → 독후감 초안(활동 답변 재사용, 아이 문장 그대로) → 제출 → 부모 피드백(칭찬/개선/질문형 수정 요청) → 수정본 → 최종본.
학년 모드: 초등 고학년은 '왜?' 2단계, 중2는 3단계.

## 3단계 보상 연동 시 확인한 점
- 용돈 원장(allowance_ledger)은 family_state의 JSON이고 동시 변경은 value_json 비교 갱신(최대 5회 재시도)으로 처리한다.
- 보상 지급은 이 경로를 재사용하고, 지급 전에 reading_rewards 행을 먼저 만들어 중복을 막는다.
- 지급은 부모 승인 시점에만 한다.

## 열린 항목
- 질문 은행 초안(학년별) 작성
- 한국어 AI 질문 품질은 2단계에서 가족이 직접 확인
- 로그인 보안 강화 승인 여부
