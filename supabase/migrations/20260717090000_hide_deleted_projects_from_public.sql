drop policy if exists "Public can read projects" on public.projects;
create policy "Public can read projects" on public.projects
for select using (deleted_at is null);

drop policy if exists "Public can read trends" on public.trends;
create policy "Public can read trends" on public.trends
for select using (
  exists (
    select 1 from public.projects p
    where p.id = trends.project_id and p.deleted_at is null
  )
);

drop policy if exists "Public can read metrics" on public.metrics;
create policy "Public can read metrics" on public.metrics
for select using (
  exists (
    select 1 from public.projects p
    where p.id = metrics.project_id and p.deleted_at is null
  )
);

drop policy if exists "Public can read tasks" on public.tasks;
create policy "Public can read tasks" on public.tasks
for select using (
  exists (
    select 1 from public.projects p
    where p.id = tasks.project_id and p.deleted_at is null
  )
);
