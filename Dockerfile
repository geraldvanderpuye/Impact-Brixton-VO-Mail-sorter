FROM node:22-slim

# Install system dependencies:
#   poppler-utils  — required by pdf2pic for PDF→image conversion
#   tesseract-ocr  — required by node-tesseract-ocr for OCR
#   python3/make/g++ — required to compile better-sqlite3 native module
RUN apt-get update && apt-get install -y \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend dependencies first (layer cache)
COPY package*.json ./
RUN npm ci

# Install and build the React frontend
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

# Copy server source
COPY server/ ./server/

# SQLite data directory — mount a Railway volume here to persist the database
RUN mkdir -p /app/data

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "server/index.js"]
