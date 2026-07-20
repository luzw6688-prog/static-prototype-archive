-- PostgREST sends JSON stage numbers as integers. Replace smallint RPC arguments to avoid ambiguous casts.

drop function if exists public.set_project_stage_gate(uuid, smallint, text, boolean);
drop function if exists public.change_project_stage(uuid, smallint, text);

create or replace function public.set_project_stage_gate(
  p_project_id uuid,
  p_stage integer,
  p_gate_key text,
  p_completed boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_stage smallint;
  v_total integer;
  v_done integer;
begin
  if not public.is_dashboard_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  select stage into v_current_stage from public.projects
  where id = p_project_id and deleted_at is null for update;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  if v_current_stage <> p_stage then raise exception 'GATE_STAGE_NOT_CURRENT'; end if;
  if not exists (select 1 from public.stage_gate_definitions where stage = p_stage and gate_key = p_gate_key) then
    raise exception 'GATE_NOT_FOUND';
  end if;

  insert into public.project_stage_gates (project_id, stage, gate_key, completed, completed_at, completed_by)
  values (p_project_id, p_stage::smallint, p_gate_key, p_completed,
    case when p_completed then now() else null end,
    case when p_completed then auth.jwt() ->> 'email' else null end)
  on conflict (project_id, stage, gate_key) do update set
    completed = excluded.completed,
    completed_at = excluded.completed_at,
    completed_by = excluded.completed_by;

  select count(*) into v_total from public.stage_gate_definitions where required;
  select count(*) into v_done
  from public.project_stage_gates g
  join public.stage_gate_definitions d on d.stage = g.stage and d.gate_key = g.gate_key
  where g.project_id = p_project_id and d.required and g.completed;
  update public.projects
  set progress = case when v_total = 0 then 0 else round(v_done * 100.0 / v_total)::smallint end
  where id = p_project_id;
end;
$$;

create or replace function public.change_project_stage(
  p_project_id uuid,
  p_target_stage integer,
  p_reason text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from smallint;
  v_name text;
  v_missing integer;
  v_type text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_actor text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not public.is_dashboard_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_target_stage is null or p_target_stage < 0 or p_target_stage > 4 then
    raise exception 'INVALID_TARGET_STAGE';
  end if;
  select stage, name into v_from, v_name from public.projects
  where id = p_project_id and deleted_at is null for update;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  if v_from = p_target_stage then raise exception 'STAGE_UNCHANGED'; end if;

  if p_target_stage > v_from then
    select count(*) into v_missing
    from public.stage_gate_definitions d
    left join public.project_stage_gates g
      on g.project_id = p_project_id and g.stage = d.stage and g.gate_key = d.gate_key and g.completed
    where d.stage = v_from and d.required and g.id is null;
    if v_missing > 0 then raise exception 'STAGE_GATES_INCOMPLETE:%', v_missing; end if;
  end if;
  if p_target_stage < v_from and v_reason is null then raise exception 'ROLLBACK_REASON_REQUIRED'; end if;
  if abs(p_target_stage - v_from) > 1 and v_reason is null then raise exception 'CROSS_STAGE_REASON_REQUIRED'; end if;

  v_type := case
    when p_target_stage < v_from then 'rollback'
    when p_target_stage = v_from + 1 then 'advance'
    else 'cross_stage'
  end;
  v_reason := coalesce(v_reason, '当前阶段必填门槛全部完成');
  update public.projects set stage = p_target_stage::smallint where id = p_project_id;
  insert into public.stage_history (project_id, from_stage, to_stage, change_type, reason, actor_email)
  values (p_project_id, v_from, p_target_stage::smallint, v_type, v_reason, v_actor);
  insert into public.activity_logs (project_id, type, text, actor_email)
  values (p_project_id, '阶段流转', format('项目「%s」从「%s」调整至「%s」：%s', v_name,
    (array['立项','趋势验证','Demo MVP','小流量测试','规模转化'])[v_from + 1],
    (array['立项','趋势验证','Demo MVP','小流量测试','规模转化'])[p_target_stage + 1], v_reason), v_actor);
end;
$$;

grant execute on function public.set_project_stage_gate(uuid, integer, text, boolean) to authenticated;
grant execute on function public.change_project_stage(uuid, integer, text) to authenticated;
