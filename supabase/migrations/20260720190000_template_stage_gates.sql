-- Materialise template-specific stage gates and enforce them on advancement.

create table if not exists public.project_template_gates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stage smallint not null check (stage between 0 and 4),
  label text not null,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique(project_id,stage,label)
);
alter table public.project_template_gates enable row level security;
drop policy if exists "Public can read template gates" on public.project_template_gates;
create policy "Public can read template gates" on public.project_template_gates for select using (true);
drop policy if exists "Admin manages template gates" on public.project_template_gates;
create policy "Admin manages template gates" on public.project_template_gates for all
using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());
grant select on public.project_template_gates to anon, authenticated;
grant insert, update, delete on public.project_template_gates to authenticated;

create or replace function public.create_project_from_template(
  p_template_id uuid, p_name text, p_intro text, p_category text,
  p_subcategory text, p_owner text, p_members text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_project_id uuid;
  v_template public.validation_templates%rowtype;
  v_item jsonb;
  v_gate text;
  v_parts text[];
  v_stage smallint;
  v_position integer := 0;
begin
  if not public.is_dashboard_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  select * into v_template from public.validation_templates where id = p_template_id;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;
  insert into public.projects(name,intro,category,subcategory,owner,members,template_id)
  values(trim(p_name),trim(p_intro),p_category,p_subcategory,trim(p_owner),trim(p_members),p_template_id)
  returning id into v_project_id;

  for v_item in select value from jsonb_array_elements(v_template.stage_gates) loop
    v_gate := trim(both '"' from v_item::text);
    v_parts := string_to_array(v_gate,'|');
    v_stage := case trim(v_parts[1]) when '立项' then 0 when '趋势验证' then 1 when 'Demo MVP' then 2 when '小流量测试' then 3 when '规模转化' then 4 else 0 end;
    insert into public.project_template_gates(project_id,stage,label)
    values(v_project_id,v_stage,coalesce(nullif(trim(v_parts[2]),''),trim(v_parts[1]))) on conflict do nothing;
  end loop;
  for v_item in select value from jsonb_array_elements(v_template.standard_tasks) loop
    insert into public.tasks(project_id,title,owner,due,criteria,priority,confirmation_status,stage)
    values(v_project_id,coalesce(v_item->>'title','模板任务'),trim(p_owner),current_date + coalesce((v_item->>'days')::integer,7),
      coalesce(v_item->>'criteria','按模板完成并留下证据'),coalesce(v_item->>'priority','中'),'confirmed',coalesce((v_item->>'stage')::smallint,0));
  end loop;
  for v_item in select value from jsonb_array_elements(v_template.recommended_metrics) loop
    insert into public.metrics(project_id,name,unit,baseline_value,target_value,comparison_operator,stage,is_key,position)
    values(v_project_id,coalesce(v_item->>'name','模板指标'),coalesce(v_item->>'unit','自定义'),coalesce((v_item->>'baseline')::numeric,0),
      coalesce((v_item->>'target')::numeric,0),coalesce(v_item->>'operator','>='),coalesce((v_item->>'stage')::smallint,0),true,v_position);
    v_position := v_position + 1;
  end loop;
  insert into public.activity_logs(project_id,type,text,actor_email)
  values(v_project_id,'模板',format('使用模板「%s」v%s 创建项目「%s」',v_template.name,v_template.version,p_name),auth.jwt()->>'email');
  return v_project_id;
end; $$;
grant execute on function public.create_project_from_template(uuid,text,text,text,text,text,text) to authenticated;

create or replace function public.set_project_template_gate(p_gate_id uuid,p_completed boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_dashboard_admin() then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  update public.project_template_gates set completed=p_completed,updated_at=now() where id=p_gate_id;
  if not found then raise exception 'TEMPLATE_GATE_NOT_FOUND'; end if;
end; $$;
grant execute on function public.set_project_template_gate(uuid,boolean) to authenticated;

create or replace function public.enforce_template_gates_on_stage_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.stage > old.stage and exists (
    select 1 from public.project_template_gates
    where project_id=old.id and stage=old.stage and not completed
  ) then raise exception 'TEMPLATE_GATES_INCOMPLETE'; end if;
  return new;
end; $$;
drop trigger if exists projects_enforce_template_gates on public.projects;
create trigger projects_enforce_template_gates before update of stage on public.projects
for each row execute function public.enforce_template_gates_on_stage_change();

do $$ begin alter publication supabase_realtime add table public.project_template_gates;
exception when duplicate_object then null; end $$;
