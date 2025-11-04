FROM node:18

WORKDIR /app

# Install dependencies first (leverages Docker cache)
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

ENV PORT=3000
ENV NODE_ENV=development

EXPOSE 3000

# Run nodemon via npm script so it will reload on file changes
CMD ["npm", "run", "dev"]
