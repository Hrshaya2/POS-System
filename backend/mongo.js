const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || '';
const isServerless = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const connectionOptions = {
    maxPoolSize: isServerless ? 5 : 10,
    minPoolSize: 0,
    maxIdleTimeMS: 10000,
    serverSelectionTimeoutMS: 5000,
    ...(isServerless ? { bufferCommands: false } : {})
};
if (isServerless) mongoose.set('bufferCommands', false);

const cache = globalThis.__nangiMongoCache || { connectionPromise: null };
globalThis.__nangiMongoCache = cache;

const connectDB = async () => {
    if (mongoose.connection.readyState === 1) return mongoose.connection;
    if (!MONGO_URI) throw new Error('MONGO_URI is not configured');
    if (!cache.connectionPromise) {
        console.log('Mongo: new connection created');
        cache.connectionPromise = mongoose.connect(MONGO_URI, connectionOptions).catch((err) => {
            cache.connectionPromise = null;
            throw err;
        });
    }
    return cache.connectionPromise;
};

module.exports = { mongoose, connectDB };
