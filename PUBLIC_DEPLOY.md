# 外网访问部署说明

## 方案 A：这台 Windows 电脑直接给外网访问

适合临时测试，不建议长期给客户用。

1. 双击 `start-public.bat`
2. 右键 `open-firewall-4173.bat`，选择“以管理员身份运行”
3. 在路由器里做端口转发：
   - 外部端口：`4173`
   - 内部 IP：这台电脑的局域网 IP，例如 `192.168.1.25`
   - 内部端口：`4173`
   - 协议：`TCP`
4. 客户访问：
   - `http://你的公网IP:4173`

注意：
- 你的宽带必须有公网 IP，否则路由器转发也没用。
- 上线前必须进入 `/admin` 修改默认管理员密码。
- 不建议裸露 HTTP 给长期客户使用。

## 方案 B：云服务器 + 域名 + HTTPS

推荐长期使用。

1. 买一台云服务器，系统用 Windows 或 Linux 都可以。
2. 安装 Node.js LTS。
3. 把整个 `E:\TEST3` 项目上传到服务器。
4. 启动服务：
   - Windows：双击 `start-public.bat`
   - Linux：`HOST=127.0.0.1 PORT=4173 node server.js`
5. 云服务器安全组开放端口：
   - 临时测试：开放 `4173`
   - 正式域名：开放 `80` 和 `443`
6. 域名解析到服务器公网 IP。
7. 用 Nginx 做 HTTPS 反向代理。

Nginx 示例：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

正式访问地址：

```text
https://your-domain.com
```

## 首次上线检查

1. 打开 `/login`
2. 用 `admin / admin123` 登录
3. 进入 `/admin`
4. 立即修改 admin 密码
5. 填写 API 地址、API Key、生图模型、LLM 模型
6. 添加普通用户
7. 用普通用户登录测试生成

## 常见问题

如果局域网能访问，外网不能访问：
- 路由器没有端口转发
- 宽带不是公网 IP
- Windows 防火墙没有放行
- 云服务器安全组没有开放端口

如果登录后图片生成失败：
- 先用管理员去 `/admin` 测试 API 连接
- 检查中转站 API Key 是否有额度
- 检查模型名是否和中转站一致
