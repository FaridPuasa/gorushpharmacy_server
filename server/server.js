import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import compression from 'compression';
import NodeCache from 'node-cache';
import authRoutes from './routes/auth.js';

dotenv.config();

// Enhanced cache configuration
const cache = new NodeCache({ 
  stdTTL: process.env.CACHE_TTL || 300, // 5 minutes default
  checkperiod: 60, // Check for expired keys every minute
  useClones: false // Don't clone data for better performance
});

const app = express();

// Performance monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) { // Log slow requests
      console.log(`🐌 Slow request: ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  
  next();
});

// Enhanced CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://grpharmacyappfrontend.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Role'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Keep-alive headers for better connection reuse
app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  next();
});

app.use(compression());
app.use(express.json({ limit: '10mb' }));

const uri = process.env.MONGO_URI;

// Optimized MongoDB connection
const mongoOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10, // Maintain up to 10 socket connections
  serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  family: 4, // Use IPv4, skip trying IPv6
  bufferCommands: false, // Disable mongoose buffering
  bufferMaxEntries: 0 // Disable mongoose buffering
};

// Create connection state tracking
let isConnected = false;
let connectionPromise = null;

// Initialize MongoDB connection
const initializeDatabase = async () => {
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = mongoose.connect(uri, mongoOptions);
  
  try {
    await connectionPromise;
    isConnected = true;
    console.log("✅ MongoDB connected with optimized settings");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    isConnected = false;
    connectionPromise = null;
    throw err;
  }

  return connectionPromise;
};

// Connection event handlers
mongoose.connection.on('connected', () => {
  isConnected = true;
  console.log('✅ MongoDB connection established');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
  isConnected = false;
});

// Initialize connection
initializeDatabase().catch(console.error);

// Middleware to check MongoDB connection
const ensureDbConnection = async (req, res, next) => {
  if (!isConnected) {
    try {
      await initializeDatabase();
    } catch (error) {
      console.error('Failed to connect to MongoDB:', error);
      return res.status(503).json({ 
        error: 'Database connection unavailable',
        message: 'Please try again in a moment'
      });
    }
  }
  next();
};

// Optimized schema with proper indexing
const orderSchema = new mongoose.Schema({
  product: { type: String, enum: ['pharmacyjpmc', 'pharmacymoh'], index: true},
  creationDate: { type: Date, index: true }, // For date filtering
  patientNumber: { type: String, index: true }, // For customer queries
  receiverName: { type: String, index: true }, // For customer grouping
  collectionDate: { type: Date, index: true }, // For collection date queries
  goRushStatus: { type: String, default: 'pending', index: true },
  pharmacyStatus: { type: String, default: 'pending', index: true },
  logs: [
    {
      note: { type: String, required: true },
      category: { type: String, required: true },
      createdBy: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  pharmacyRemarks: [
    {
      remark: { type: String, required: true },
      createdBy: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    }
  ],
}, { collection: 'orders', strict: false });

// Create compound indexes for complex queries
orderSchema.index({ product: 1, creationDate: -1 }); // For filtered queries
orderSchema.index({ receiverName: 1, patientNumber: 1 }); // For customer grouping
orderSchema.index({ collectionDate: 1, product: 1 }); // For collection date queries

const Order = mongoose.model('Order', orderSchema);

// Cache helper functions
function invalidateCache(pattern) {
  const keys = cache.keys();
  keys.forEach(key => {
    if (key.includes(pattern)) {
      cache.del(key);
    }
  });
}

function getCacheKey(req, prefix) {
  const role = req.userRole || 'jpmc';
  const query = JSON.stringify(req.query);
  return `${prefix}-${role}-${query}`;
}

const getDateFilter = () => {
  return {
    creationDate: {
      $gte: '2025-01-01'
    }
  };
};

function getProductFilter(userRole) {
  const role = (userRole || '').toLowerCase().trim();

  if (role === 'moh') {
    return { 
      $or: [
        { product: 'pharmacymoh' },
        { 
          $and: [
            { product: { $exists: true } },
            { product: { $nin: ['pharmacyjpmc', 'kptdp', 'other_product'] } }
          ]
        }
      ]
    };
  }

  if (role === 'jpmc') {
    return { 
      $or: [
        { product: 'pharmacyjpmc' },
        { product: { $exists: false } } // Include legacy orders
      ]
    };
  }

  if (role === 'gorush') {
    return {
      product: { $in: ['pharmacymoh', 'pharmacyjpmc'] }
    };
  }

  return {};
}

function canAccessOrder(userRole, order) {
  const role = (userRole || '').toLowerCase().trim();
  
  // Go Rush can access any order
  if (role === 'gorush' || role === 'go-rush') return true;
  
  // MOH can only access MOH orders
  if (role === 'moh') return order.product === 'pharmacymoh';
  
  // JPMC can access JPMC orders and legacy orders
  if (role === 'jpmc') {
    return order.product === 'pharmacyjpmc' || !order.product;
  }
  
  return false;
}

function canUpdateOrder(userRole, order, updateType) {
  const role = (userRole || '').toLowerCase().trim();
  
  // Go Rush can update Go Rush status on any order
  if (updateType === 'goRushStatus') {
    return role === 'gorush' || role === 'go-rush';
  }
  
  // Pharmacy status and remarks can only be updated by the appropriate pharmacy
  if (updateType === 'pharmacyStatus' || updateType === 'pharmacyRemarks') {
    if (role === 'moh') return order.product === 'pharmacymoh';
    if (role === 'jpmc') return order.product === 'pharmacyjpmc' || !order.product;
  }
  
  // Logs can be added by Go Rush on any order
  if (updateType === 'logs') {
    return role === 'gorush' || role === 'go-rush';
  }
  
  return false;
}

function getQueryOptions(userRole) {
  const role = (userRole || '').toLowerCase().trim();
  
  return {
    sort: { creationDate: -1 }
  };
}

function getCombinedFilter(userRole) {
  const productFilter = getProductFilter(userRole);
  const dateFilter = getDateFilter();
  
  return {
    ...productFilter,
    ...dateFilter
  };
}

// Middleware to extract user role from headers
function extractUserRole(req, res, next) {
  req.userRole = req.headers['x-user-role'] || req.query.role || 'jpmc';
  next();
}

// Health check endpoint for keeping service warm
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dbConnected: isConnected
  });
});

app.get('/', (req, res) => {
  res.send('GR Pharmacy Backend is running ✅');
});

// Apply user role middleware to all API routes
app.use('/api', extractUserRole);

// Apply database connection middleware to all API routes
app.use('/api', ensureDbConnection);

app.use('/api/orders', (req, res, next) => {
  console.log(`[${new Date().toISOString()}] Role: ${req.userRole}, Path: ${req.path}`);
  next();
});

app.use('/api/auth', authRoutes);

// Optimized orders endpoint
app.get('/api/orders', async (req, res) => {
  try {
    const role = req.userRole || 'jpmc';
    const cacheKey = getCacheKey(req, 'orders');

    // Check cache first
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const combinedFilter = getCombinedFilter(role);
    const queryOptions = getQueryOptions(role);

    // Use lean() for better performance - returns plain JS objects
    const orders = await Order.find(combinedFilter)
      .sort(queryOptions.sort || {})
      .lean() // This is crucial for performance
      .limit(1000) // Add reasonable limit
      .exec();

    // Cache with shorter TTL for frequently changing data
    cache.set(cacheKey, orders, 180); // 3 minutes for orders
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized customers endpoint
app.get('/api/customers', async (req, res) => {
  try {
    const role = req.userRole || 'jpmc';
    const cacheKey = getCacheKey(req, 'customers');

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const combinedFilter = getCombinedFilter(role);

    // Optimize aggregation pipeline
    let aggregationPipeline = [
      { $match: combinedFilter },
      { $sort: { creationDate: -1 } },
      { 
        $group: {
          _id: {
            receiverName: "$receiverName",
            patientNumber: "$patientNumber"
          },
          totalOrders: { $sum: 1 },
          lastOrderDate: { $max: "$creationDate" },
          firstOrderDate: { $min: "$creationDate" }
        }
      },
      {
        $project: {
          _id: 0,
          receiverName: "$_id.receiverName",
          patientNumber: "$_id.patientNumber",
          totalOrders: 1,
          lastOrderDate: 1,
          firstOrderDate: 1
        }
      },
      { $sort: { receiverName: 1 } },
      { $limit: 500 } // Add reasonable limit
    ];

    const customers = await Order.aggregate(aggregationPipeline).exec();
    
    // Cache customers for longer since they change less frequently
    cache.set(cacheKey, customers, 600); // 10 minutes
    res.json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized customer orders endpoint
app.get('/api/customers/:patientNumber/orders', async (req, res) => {
  try {
    const { patientNumber } = req.params;
    const cacheKey = getCacheKey(req, `customer-orders-${patientNumber}`);
    
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const combinedFilter = getCombinedFilter(req.userRole);
    
    const orders = await Order.find({ 
      ...combinedFilter,
      patientNumber: patientNumber 
    })
    .sort({ creationDate: -1 })
    .lean()
    .limit(100)
    .exec();
    
    cache.set(cacheKey, orders, 300); // 5 minutes
    res.json(orders);
  } catch (error) {
    console.error('Error fetching customer orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized collection date update with cache invalidation
app.put('/api/orders/:id/collection-date', async (req, res) => {
  try {
    const { id } = req.params;
    const { collectionDate, collectionStatus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID format' });
    }

    // First find the order without product filter
    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can access this order
    if (!canAccessOrder(req.userRole, order)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updateData = {
      updatedAt: new Date()
    };

    if (collectionDate === null || collectionDate === '') {
      updateData.collectionDate = null;
      updateData.collectionStatus = collectionStatus || 'pending';
    } else if (collectionDate) {
      updateData.collectionDate = new Date(collectionDate);
    } else {
      return res.status(400).json({ 
        error: 'Missing collectionDate in request body' 
      });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      updateData,
      { new: true, lean: true }
    );

    // Invalidate related caches
    invalidateCache('orders');
    invalidateCache('customers');
    invalidateCache('collection-dates');

    res.json(updatedOrder);
  } catch (error) {
    console.error('Server error updating collection date:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Optimized collection dates endpoint
app.get('/api/collection-dates', async (req, res) => {
  try {
    const cacheKey = getCacheKey(req, 'collection-dates');
    
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const combinedFilter = getCombinedFilter(req.userRole);
    
    const matchCondition = {
      collectionDate: { $exists: true, $ne: null },
      ...combinedFilter
    };
    
    let aggregationPipeline = [
      { $match: matchCondition },
      { $sort: { creationDate: -1 } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$collectionDate" } },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          dateString: "$_id",
          date: { $toDate: "$_id" },
          orderCount: "$count",
          _id: 0
        }
      },
      { $sort: { date: 1 } },
      { $limit: 100 } // Reasonable limit
    ];
    
    const dates = await Order.aggregate(aggregationPipeline).exec();
    
    cache.set(cacheKey, dates, 600); // 10 minutes
    res.json(dates);
  } catch (error) {
    console.error('Error fetching collection dates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized orders by collection date
app.get('/api/orders/collection-dates', async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    const cacheKey = getCacheKey(req, `orders-by-date-${date}`);
    
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(date);
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    
    const combinedFilter = getCombinedFilter(req.userRole);
    
    const orders = await Order.find({
      collectionDate: {
        $gte: startDate,
        $lt: endDate
      },
      ...combinedFilter
    })
    .sort({ collectionDate: 1 })
    .lean()
    .limit(500)
    .exec();

    cache.set(cacheKey, orders, 300); // 5 minutes
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders for date:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized single order endpoint
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    // Check cache first
    const cacheKey = `order-${id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      if (canAccessOrder(req.userRole, cached)) {
        return res.json(cached);
      } else {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const order = await Order.findById(id).lean();
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canAccessOrder(req.userRole, order)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    cache.set(cacheKey, order, 300); // 5 minutes
    res.json(order);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized DeTrack endpoint
app.get('/api/detrack/:trackingNumber', async (req, res) => {
  try {
    const { trackingNumber } = req.params;
    
    if (!trackingNumber) {
      return res.status(400).json({ error: 'Tracking number is required' });
    }

    // Check cache first
    const cacheKey = `detrack-${trackingNumber}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const response = await fetch(`https://app.detrack.com/api/v2/dn/jobs/show/?do_number=${trackingNumber}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.DETRACK_API_KEY || 'Ude778d93ebd628e6c942a4c4f359643e9cefc1949b17d433'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('DeTrack API error:', response.status, errorText);
      throw new Error(`DeTrack API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Cache DeTrack data for 5 minutes
    cache.set(cacheKey, data, 300);
    res.json(data);
    
  } catch (error) {
    console.error('Error fetching DeTrack data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch DeTrack data',
      details: error.message 
    });
  }
});

// Optimized Go Rush status update
app.put('/api/orders/:id/go-rush-status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canUpdateOrder(req.userRole, order, 'goRushStatus')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { 
        goRushStatus: status,
        updatedAt: new Date()
      },
      { new: true, lean: true, runValidators: false }
    );

    // Invalidate caches
    invalidateCache('orders');
    cache.del(`order-${id}`);

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating Go Rush status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized Pharmacy status update
app.put('/api/orders/:id/pharmacy-status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canUpdateOrder(req.userRole, order, 'pharmacyStatus')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { 
        pharmacyStatus: status,
        updatedAt: new Date()
      },
      { new: true, lean: true, runValidators: false }
    );

    // Invalidate caches
    invalidateCache('orders');
    cache.del(`order-${id}`);

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating Pharmacy status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Legacy status endpoint (backward compatibility)
app.put('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canUpdateOrder(req.userRole, order, 'goRushStatus')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { 
        goRushStatus: status,
        updatedAt: new Date()
      },
      { new: true, lean: true, runValidators: false }
    );

    // Invalidate caches
    invalidateCache('orders');
    cache.del(`order-${id}`);

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized logs endpoint
app.post('/api/orders/:id/logs', async (req, res) => {
  const { id } = req.params;
  const { note, category, createdBy } = req.body;

  if (!note || !category || !createdBy) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canUpdateOrder(req.userRole, order, 'logs')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const logEntry = {
      note,
      category,
      createdBy,
      createdAt: new Date(),
    };

    order.logs.push(logEntry);
    await order.save();

    // Invalidate caches
    invalidateCache('orders');
    cache.del(`order-${id}`);

    res.status(201).json({ message: 'Log added successfully', log: logEntry });
  } catch (err) {
    console.error('Error adding log:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Optimized pharmacy remarks endpoint
app.post('/api/orders/:id/pharmacy-remarks', async (req, res) => {
  const { id } = req.params;
  const { remark, createdBy } = req.body;

  if (!remark || !createdBy) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canUpdateOrder(req.userRole, order, 'pharmacyRemarks')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const entry = {
      remark,
      createdBy,
      createdAt: new Date(),
    };

    order.pharmacyRemarks.push(entry);
    await order.save();

    // Invalidate caches
    invalidateCache('orders');
    cache.del(`order-${id}`);

    res.status(201).json({ message: 'Remark added', remark: entry });
  } catch (err) {
    console.error('Error adding remark:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`💾 Cache TTL: ${process.env.CACHE_TTL || 300} seconds`);
  console.log(`🔍 MongoDB Pool Size: ${mongoOptions.maxPoolSize}`);
});