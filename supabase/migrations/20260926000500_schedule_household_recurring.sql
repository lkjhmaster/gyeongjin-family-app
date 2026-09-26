-- 매월 고정지출을 앱 접속 여부와 무관하게 자동 적용
-- 기준 시간: 한국 표준시(KST) 00:05 = UTC 15:05
-- 기존 apply_household_recurring() 로직을 그대로 호출하여 기존 가계부 데이터 계산 규칙을 재사용합니다.
-- 중복 방지는 기존 DB 함수의 책임으로 두어 기존 데이터에 직접적인 변경을 가하지 않습니다.

create extension if not exists pg_cron;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'gyeongjin-household-recurring-daily';

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end
$$;

select cron.schedule(
  'gyeongjin-household-recurring-daily',
  '5 15 * * *',
  $$select public.apply_household_recurring();$$
);
