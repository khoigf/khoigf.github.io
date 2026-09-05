FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV TZ=Asia/Ho_Chi_Minh

COPY vecom /app/vecom
COPY quy /app/quy

WORKDIR /app/vecom/bot
RUN npm install --omit=dev --ignore-scripts

EXPOSE 3000
CMD ["node", "server.js"]
