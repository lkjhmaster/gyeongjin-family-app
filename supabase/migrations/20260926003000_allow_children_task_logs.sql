-- Allow child accounts to record/remove their own daily task completion logs.
drop policy if exists children_insert_allowance_tasks on public.allowance_tasks;
create policy children_insert_allowance_tasks
on public.allowance_tasks
for insert
to authenticated
with check (
  exists (
    select 1 from public.allowance_children c
    where c.id = allowance_tasks.child_id
      and c.user_id = auth.uid()
  )
  and created_by = auth.uid()
  and updated_by = auth.uid()
);

drop policy if exists children_delete_allowance_tasks on public.allowance_tasks;
create policy children_delete_allowance_tasks
on public.allowance_tasks
for delete
to authenticated
using (
  exists (
    select 1 from public.allowance_children c
    where c.id = allowance_tasks.child_id
      and c.user_id = auth.uid()
  )
);
