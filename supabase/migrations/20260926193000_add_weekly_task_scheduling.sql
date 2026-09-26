alter table public.allowance_tasks
  add column if not exists scheduled_date date;

create index if not exists allowance_tasks_child_scheduled_date_idx
  on public.allowance_tasks(child_id, scheduled_date)
  where active = true;
