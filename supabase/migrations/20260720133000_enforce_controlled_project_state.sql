-- Prevent authenticated clients from bypassing gate-driven progress and structured stage history.

create or replace function public.enforce_controlled_project_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.stage is distinct from old.stage and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'USE_CHANGE_PROJECT_STAGE_RPC' using errcode = '42501';
  end if;
  if new.progress is distinct from old.progress and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'PROJECT_PROGRESS_IS_AUTOMATIC' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_enforce_controlled_state on public.projects;
create trigger projects_enforce_controlled_state before update of stage, progress on public.projects
for each row execute function public.enforce_controlled_project_state();
