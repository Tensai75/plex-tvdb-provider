FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
RUN install -d -o 10001 -g 10001 -m 0750 /data
COPY --chmod=0444 application/*.mjs ./
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]
CMD ["node", "/app/main.mjs"]
