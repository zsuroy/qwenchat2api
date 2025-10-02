FROM denoland/deno:alpine-2.0.0
WORKDIR /app

# 复制项目文件并设置正确的所有权
COPY --chown=deno:deno main.ts .

# 使用镜像中已存在的deno用户
USER deno

# 暴露端口
EXPOSE 8000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8000/v1/models || exit 1

# 运行服务
CMD ["run", "--allow-net", "--allow-env", "main.ts"]