# 公司项目看板

用于呈现公司项目、趋势验证、阶段流转、验证指标和下一步任务的在线协作看板。

线上地址：https://luzw6688-prog.github.io/static-prototype-archive/

## 数据与权限

- 前端由 GitHub Pages 托管。
- 项目、趋势、指标、任务和操作记录保存在 Supabase。
- 未登录访客可以公开查看最新数据。
- 只有固定管理员 `luzw6688@gmail.com` 登录后可以新增、编辑、推进、删除和恢复项目。
- 项目删除采用软删除，可在“数据口径”的已删除项目区域恢复。
- 数据库启用了 Row Level Security，未登录用户没有写入权限。

## 管理员登录

管理员账号已经固定为 `luzw6688@gmail.com`，新用户注册已经关闭。打开线上看板后点击“管理员登录”，使用已设置的密码即可进入编辑模式。

数据库迁移文件位于 `supabase/migrations/`，前端只包含可公开使用的 Supabase publishable key，不包含数据库管理员密钥。
