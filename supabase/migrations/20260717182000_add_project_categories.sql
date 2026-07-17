-- Add stable app-market classification to projects without changing trend mappings.

alter table public.projects
  add column if not exists category text not null default '未分类',
  add column if not exists subcategory text not null default '待补充';

