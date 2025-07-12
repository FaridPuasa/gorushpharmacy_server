import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import compression from 'compression';
import authRoutes from './routes/auth.js';

dotenv.config();

const app = express();

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

app.use(cors(corsOptions)); // Apply CORS with options
app.options('*', cors(corsOptions)); // Enable preflight for all routes

app.use(compression());

app.use(express.json());

const uri = process.env.MONGO_URI;

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// Define schema + model
const orderSchema = new mongoose.Schema({
  product: { type: String, enum: ['pharmacyjpmc', 'pharmacymoh'], index: true},
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
// Added dual status fields
goRushStatus: { type: String, default: 'pending' }, // Status for Go Rush team
pharmacyStatus: { type: String, default: 'pending' } // Status for Pharmacy team
}, { collection: 'orders', strict: false });
const Order = mongoose.model('Order', orderSchema);

const getDateFilter = () => {
  return {
    creationDate: {
      $gte: '2025-07-11'
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

// New function for determining update permissions
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

// Updated to use date filter instead of limits
function getQueryOptions(userRole) {
  const role = (userRole || '').toLowerCase().trim();
  
  // All roles now use the same date-based filter
  return {
    sort: { creationDate: -1 }
  };
}

// Helper function to combine all filters
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
  req.userRole = req.headers['x-user-role'] || req.query.role || 'jpmc'; // Default to jpmc
  next();
}

app.get('/', (req, res) => {
  res.send('GR Pharmacy Backend is running ✅');
});

// Apply user role middleware to all routes
app.use('/api', extractUserRole);

app.use('/api/orders', (req, res, next) => {
  console.log(`[${new Date().toISOString()}] Role: ${req.userRole}, Path: ${req.path}`);
  next();
});

app.use('/api/auth', authRoutes);

app.get('/api/orders', async (req, res) => {
  try {
    const combinedFilter = getCombinedFilter(req.userRole);
    const queryOptions = getQueryOptions(req.userRole);

    console.log(`🏷️ User role: ${req.userRole}`);
    console.log(`🔍 Combined filter:`, combinedFilter);

    let query = Order.find(combinedFilter)
      .sort(queryOptions.sort || {});

    const orders = await query;
    res.json(orders);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const combinedFilter = getCombinedFilter(req.userRole);
    
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
      { $sort: { receiverName: 1 } }
    ];
    
    const customers = await Order.aggregate(aggregationPipeline);
    
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customers/:patientNumber/orders', async (req, res) => {
  try {
    const { patientNumber } = req.params;
    const combinedFilter = getCombinedFilter(req.userRole);
    
    let query = Order.find({ 
      ...combinedFilter,
      patientNumber: patientNumber 
    }).sort({ creationDate: -1 });
    
    const orders = await query;
    
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/orders/:id/collection-date', async (req, res) => {
  try {
    const { id } = req.params;
    const { collectionDate, collectionStatus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID format' });
    }

    // First find the order without product filter
    const order = await Order.findById(id);
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

    // Explicitly check if collectionDate is null or empty string
    if (collectionDate === null || collectionDate === '') {
      updateData.collectionDate = null;
      updateData.collectionStatus = collectionStatus || 'pending';
    } 
    // If collectionDate has a value, use it
    else if (collectionDate) {
      updateData.collectionDate = new Date(collectionDate);
    }
    // If collectionDate is undefined, don't modify it
    else {
      return res.status(400).json({ 
        error: 'Missing collectionDate in request body' 
      });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );

    res.json(updatedOrder);
  } catch (error) {
    console.error('Server error updating collection date:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

app.get('/api/collection-dates', async (req, res) => {
  try {
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
      { $sort: { date: 1 } }
    ];
    
    const dates = await Order.aggregate(aggregationPipeline);
    
    res.json(dates);
  } catch (error) {
    console.error('Error fetching collection dates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get orders for a specific collection date
app.get('/api/orders/collection-dates', async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    const startDate = new Date(date);
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    
    const combinedFilter = getCombinedFilter(req.userRole);
    
    let query = Order.find({
      collectionDate: {
        $gte: startDate,
        $lt: endDate
      },
      ...combinedFilter
    }).sort({ collectionDate: 1 });

    const orders = await query;

    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders for date:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATED: Get a specific order with proper access control
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    // First find the order without product filter
    const order = await Order.findById(id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can access this order
    if (!canAccessOrder(req.userRole, order)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(order);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/detrack/:trackingNumber', async (req, res) => {
  try {
    const { trackingNumber } = req.params;
    
    if (!trackingNumber) {
      return res.status(400).json({ error: 'Tracking number is required' });
    }

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
    res.json(data);
    
  } catch (error) {
    console.error('Error fetching DeTrack data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch DeTrack data',
      details: error.message 
    });
  }
});

// UPDATED: Go Rush Status with proper permission checking
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

    // First find the order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can update this order
    if (!canUpdateOrder(req.userRole, order, 'goRushStatus')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { 
        goRushStatus: status,
        updatedAt: new Date()
      },
      { new: true, runValidators: false }
    );

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating Go Rush status:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATED: Pharmacy Status with proper permission checking
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

    // First find the order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can update this order
    if (!canUpdateOrder(req.userRole, order, 'pharmacyStatus')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { 
        pharmacyStatus: status,
        updatedAt: new Date()
      },
      { new: true, runValidators: false }
    );

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating Pharmacy status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoint for backward compatibility (now updates goRushStatus)
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

    // First find the order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can update this order
    if (!canUpdateOrder(req.userRole, order, 'goRushStatus')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { 
        goRushStatus: status, // Default to Go Rush status for backward compatibility
        updatedAt: new Date()
      },
      { new: true, runValidators: false }
    );

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATED: Logs with proper permission checking
app.post('/api/orders/:id/logs', async (req, res) => {
  const { id } = req.params;
  const { note, category, createdBy } = req.body;

  if (!note || !category || !createdBy) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // First find the order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can update this order
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

    res.status(201).json({ message: 'Log added successfully', log: logEntry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// UPDATED: Pharmacy remarks with proper permission checking
app.post('/api/orders/:id/pharmacy-remarks', async (req, res) => {
  const { id } = req.params;
  const { remark, createdBy } = req.body;

  if (!remark || !createdBy) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    // First find the order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user can update this order
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

    res.status(201).json({ message: 'Remark added', remark: entry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});