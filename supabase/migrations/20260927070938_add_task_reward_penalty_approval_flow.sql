alter table public.allowance_tasks
  add column if not exists completion_reward_amount integer not null default 0,
  add column if not exists completion_reward_enabled boolean not null default false,
  add column if not exists noncompletion_amount integer not null default 0,
  add column if not exists noncompletion_enabled boolean not null default false;

update public.allowance_tasks
set
  completion_reward_amount = case when reward_amount > 0 then reward_amount else 0 end,
  completion_reward_enabled = reward_amount > 0,
  noncompletion_amount = case when reward_amount < 0 then reward_amount else 0 end,
  noncompletion_enabled = reward_amount < 0
where completion_reward_enabled = false
  and noncompletion_enabled = false
  and reward_amount <> 0;

alter table public.allowance_task_completions
  add column if not exists approval_status text not null default 'pending',
  add column if not exists approved_by uuid references auth.users(id),
  add column if not exists approved_at timestamptz;

alter table public.allowance_task_completions
  drop constraint if exists allowance_task_completions_approval_status_check;

alter table public.allowance_task_completions
  add constraint allowance_task_completions_approval_status_check
  check (approval_status = any (array['pending'::text,'approved'::text,'rejected'::text]));

update public.allowance_task_completions c
set
  approval_status = case
    when exists (
      select 1 from public.allowance_requests r
      where r.child_id = c.child_id
        and r.status = 'approved'
        and r.reason like '%[[TASK_APPROVAL:' || c.task_id::text || ':' || c.task_date::text || ':completed]]%'
    ) then 'approved'
    when exists (
      select 1 from public.allowance_requests r
      where r.child_id = c.child_id
        and r.status = 'rejected'
        and r.reason like '%[[TASK_APPROVAL:' || c.task_id::text || ':' || c.task_date::text || ':completed]]%'
    ) then 'rejected'
    else 'pending'
  end,
  approved_by = (
    select r.decided_by from public.allowance_requests r
    where r.child_id = c.child_id
      and r.status = 'approved'
      and r.reason like '%[[TASK_APPROVAL:' || c.task_id::text || ':' || c.task_date::text || ':completed]]%'
    order by r.created_at desc
    limit 1
  ),
  approved_at = (
    select r.created_at from public.allowance_requests r
    where r.child_id = c.child_id
      and r.status = 'approved'
      and r.reason like '%[[TASK_APPROVAL:' || c.task_id::text || ':' || c.task_date::text || ':completed]]%'
    order by r.created_at desc
    limit 1
  );

drop policy if exists task_completions_parent_update on public.allowance_task_completions;
create policy task_completions_parent_update
on public.allowance_task_completions
for update
to authenticated
using (is_parent())
with check (is_parent());

drop policy if exists task_completions_parent_insert on public.allowance_task_completions;
create policy task_completions_parent_insert
on public.allowance_task_completions
for insert
to authenticated
with check (
  is_parent()
  and completed_by = auth.uid()
);
