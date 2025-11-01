const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');

const app = express();
app.use(express.json());

// MySQL Connection Pool
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'rootpassword',
    database: process.env.MYSQL_DATABASE || 'twocents_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Redis Client
const redisClient = redis.createClient({
    socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
    }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

// Connect to Redis
redisClient.connect();

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Server is healthy' });
});

// Root endpoint
app.get('/', async (req, res) => {
    try {
        // Test Redis
        await redisClient.set('test_key', 'Hello from Redis!');
        const redisValue = await redisClient.get('test_key');
        
        // Test MySQL
        const [rows] = await pool.query('SELECT 1 + 1 AS result');
        
        res.json({
            message: "Get request received",
            redis: redisValue,
            mysql: rows[0].result,
            status: "All services connected successfully"
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Example: Create a simple table and insert data
app.get('/init-db', async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        res.json({ message: "Database initialized successfully" });
    } catch (error) {
        console.error('Database init error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Example: Add a user
app.post('/users', async (req, res) => {
    try {
        const { name, email } = req.body;
        const [result] = await pool.query(
            'INSERT INTO users (name, email) VALUES (?, ?)',
            [name, email]
        );
        
        res.json({ 
            message: "User created", 
            userId: result.insertId 
        });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ error: error.message });
    }
});

// Example: Get all users (with Redis caching)
app.get('/users', async (req, res) => {
    try {
        // Try to get from cache first
        const cached = await redisClient.get('users_list');
        if (cached) {
            return res.json({ 
                source: 'cache', 
                users: JSON.parse(cached) 
            });
        }
        
        // If not in cache, get from database
        const [rows] = await pool.query('SELECT * FROM users');
        
        // Store in cache for 60 seconds
        await redisClient.setEx('users_list', 60, JSON.stringify(rows));
        
        res.json({ 
            source: 'database', 
            users: rows 
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: error.message });
    }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`MySQL Host: ${process.env.MYSQL_HOST || 'localhost'}`);
    console.log(`Redis Host: ${process.env.REDIS_HOST || 'localhost'}`);
});