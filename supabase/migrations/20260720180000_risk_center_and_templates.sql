-- Operational risk signals, task prioritisation and reusable validation templates.

alter table public.tasks
  add column if not exists priority text not null default '中' check (priority in ('高', '中', '低')),
  add column if not exists confirmation_status text not null default 'confirmed' check (confirmation_status in ('pending', 'confirmed')),
  add column if not exists stage smallint not null default 0 check (stage between 0 and 4);

update public.tasks t set stage = p.stage
from public.projects p where p.id = t.project_id;

alter table public.projects
  add column if not exists template_id uuid;

create table if not exists public.validation_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version integer not null default 1 check (version > 0),
  opportunity_type text not null,
  target_audience text not null,
  common_hypotheses jsonb not null default '[]'::jsonb,
  recommended_methods jsonb not null default '[]'::jsonb,
  stage_gates jsonb not null default '[]'::jsonb,
  recommended_metrics jsonb not null default '[]'::jsonb,
  success_thresholds jsonb not null default '[]'::jsonb,
  estimated_cycle text not null,
  standard_tasks jsonb not null default '[]'::jsonb,
  common_failures jsonb not null default '[]'::jsonb,
  source_project_id uuid references public.projects(id) on delete set null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects drop constraint if exists projects_template_id_fkey;
alter table public.projects add constraint projects_template_id_fkey
  foreign key (template_id) references public.validation_templates(id) on delete set null;

create index if not exists projects_template_id_idx on public.projects(template_id);
drop trigger if exists validation_templates_set_updated_at on public.validation_templates;
create trigger validation_templates_set_updated_at before update on public.validation_templates
for each row execute function public.set_updated_at();

alter table public.validation_templates enable row level security;
drop policy if exists "Public can read validation templates" on public.validation_templates;
create policy "Public can read validation templates" on public.validation_templates for select using (true);
drop policy if exists "Admin manages validation templates" on public.validation_templates;
create policy "Admin manages validation templates" on public.validation_templates for all
using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());
grant select on public.validation_templates to anon, authenticated;
grant insert, update, delete on public.validation_templates to authenticated;

create or replace function public.create_project_from_template(
  p_template_id uuid,
  p_name text,
  p_intro text,
  p_category text,
  p_subcategory text,
  p_owner text,
  p_members text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_project_id uuid;
  v_template public.validation_templates%rowtype;
  v_item jsonb;
  v_position integer := 0;
begin
  if not public.is_dashboard_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  select * into v_template from public.validation_templates where id = p_template_id;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;
  insert into public.projects(name,intro,category,subcategory,owner,members,template_id)
  values(trim(p_name),trim(p_intro),p_category,p_subcategory,trim(p_owner),trim(p_members),p_template_id)
  returning id into v_project_id;

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
end;
$$;
grant execute on function public.create_project_from_template(uuid,text,text,text,text,text,text) to authenticated;

create or replace function public.template_usage_stats()
returns table(template_id uuid, usage_count bigint, success_count bigint)
language sql stable security definer set search_path = public
as $$
  select t.id, count(p.id), count(p.id) filter (where p.stage = 4)
  from public.validation_templates t left join public.projects p on p.template_id = t.id and p.deleted_at is null
  group by t.id;
$$;
grant execute on function public.template_usage_stats() to anon, authenticated;

do $$ begin alter publication supabase_realtime add table public.validation_templates;
exception when duplicate_object then null; end $$;
