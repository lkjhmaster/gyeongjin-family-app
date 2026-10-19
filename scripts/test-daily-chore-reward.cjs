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
