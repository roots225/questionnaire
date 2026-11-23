FROM oven/bun:1-alpine

WORKDIR /app

# Copie des fichiers nécessaires au serveur
COPY server.js index.html ./

# Création du dossier pour la persistance des données
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/ping').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "server.js"]
