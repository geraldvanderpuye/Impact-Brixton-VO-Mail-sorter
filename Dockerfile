FROM node:20-slim

# Install system dependencies for OCR
RUN apt-get update && apt-get install -y \
  tesseract-ocr \
  ghostscript \
  graphicsmagick \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "src/index.js"]
