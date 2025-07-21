import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import compression from 'compression';
import authRoutes from './routes/auth.js';
import cron from 'node-cron';

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
  product: { type: String, enum: ['pharmacyjpmc'], index: true},
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
      product: { $in: ['pharmacyjpmc'] }
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

app.put('/api/orders/bulk-go-rush-status', async (req, res) => {
  try {
    const { orderIds, status } = req.body;
    const userRole = req.headers['x-user-role'];

    // Validate input
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'Invalid order IDs' });
    }

    if (!status || !['pending', 'in progress', 'ready', 'collected', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Check user role
    if (userRole !== 'gorush') {
      return res.status(403).json({ error: 'Only Go Rush users can perform bulk updates' });
    }

    // Update all orders
    const result = await Order.updateMany(
      { _id: { $in: orderIds } },
      { 
        goRushStatus: status,
        updatedAt: new Date()
      }
    );

    res.json({
      message: 'Bulk update successful',
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Error during bulk update:', error);
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


// Updated DeTrack endpoint with comprehensive debugging and auto status update
app.get('/api/detrack/:trackingNumber', async (req, res) => {
  try {
    const { trackingNumber } = req.params;
    
    if (!trackingNumber) {
      return res.status(400).json({ error: 'Tracking number is required' });
    }

    console.log(`🔍 Fetching DeTrack data for tracking number: ${trackingNumber}`);

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
    console.log(`📦 DeTrack response for ${trackingNumber}:`, JSON.stringify(data, null, 2));
    
    // Check if status is "at_warehouse" and update Go Rush status
    console.log(`🔍 Checking status: ${data.status} (type: ${typeof data.status})`);
    console.log(`🔍 Checking tracking_status: ${data.tracking_status} (type: ${typeof data.tracking_status})`);
    
    if (data && data.status && data.status === 'at_warehouse') {
      console.log(`✅ Status is 'at_warehouse', proceeding with order update`);
      
      try {
        // Find order by tracking number
        console.log(`🔍 Searching for order with doTrackingNumber: ${trackingNumber}`);
        
        const order = await Order.findOne({
          doTrackingNumber: trackingNumber
        });
        
        console.log(`🔍 Order search result:`, order ? `Found order ID: ${order._id}` : 'No order found');
        
        if (order) {
          console.log(`📝 Current order status - goRushStatus: ${order.goRushStatus}, pharmacyStatus: ${order.pharmacyStatus}`);
          
          // Check if already collected to avoid unnecessary updates
          if (order.goRushStatus === 'collected') {
            console.log(`ℹ️ Order already marked as collected, skipping update`);
            data.orderUpdated = false;
            data.message = 'Order already marked as collected';
          } else {
            // Update Go Rush status to "collected"
            const updatedOrder = await Order.findByIdAndUpdate(
              order._id,
              { 
                goRushStatus: 'collected',
                updatedAt: new Date()
              },
              { new: true, runValidators: false }
            );
            
            console.log(`✅ Updated Go Rush status to 'collected' for order: ${order._id}`);
            
            // Add a log entry for this automatic update
            const logEntry = {
              note: `Status automatically updated to 'collected' based on DeTrack status: ${data.tracking_status || data.status}`,
              category: 'system',
              createdBy: 'system',
              createdAt: new Date(),
            };
            
            updatedOrder.logs.push(logEntry);
            await updatedOrder.save();
            
            console.log(`📝 Added system log entry for automatic status update`);
            
            // Include the updated order info in the response
            data.orderUpdated = true;
            data.updatedGoRushStatus = 'collected';
            data.orderId = order._id;
          }
        } else {
          console.log(`⚠️ No order found with tracking number: ${trackingNumber}`);
          
          // Debug: Let's see what doTrackingNumbers exist in the database
          const allTrackingNumbers = await Order.aggregate([
            { $match: { doTrackingNumber: { $exists: true, $ne: null } } },
            { $project: { doTrackingNumber: 1, _id: 1 } },
            { $limit: 10 }
          ]);
          
          console.log(`🔍 Sample doTrackingNumbers in database:`, allTrackingNumbers);
          
          data.orderUpdated = false;
          data.message = 'No order found with this tracking number';
          data.searchedTrackingNumber = trackingNumber;
        }
      } catch (updateError) {
        console.error('❌ Error updating order status:', updateError);
        data.orderUpdated = false;
        data.updateError = updateError.message;
      }
    } else {
      console.log(`ℹ️ Status is not 'at_warehouse', no update needed. Current status: ${data.status}`);
      data.orderUpdated = false;
      data.message = `No update needed. Current status: ${data.status}`;
    }
    
    res.json(data);
    
  } catch (error) {
    console.error('❌ Error fetching DeTrack data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch DeTrack data',
      details: error.message 
    });
  }
});


// Alternative: Create a separate endpoint for bulk tracking updates
app.post('/api/detrack/bulk-update', async (req, res) => {
  try {
    const { trackingNumbers } = req.body;
    
    if (!trackingNumbers || !Array.isArray(trackingNumbers)) {
      return res.status(400).json({ error: 'trackingNumbers array is required' });
    }
    
    const results = [];
    
    for (const trackingNumber of trackingNumbers) {
      try {
        // Fetch DeTrack status
        const response = await fetch(`https://app.detrack.com/api/v2/dn/jobs/show/?do_number=${trackingNumber}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': process.env.DETRACK_API_KEY || 'Ude778d93ebd628e6c942a4c4f359643e9cefc1949b17d433'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          
          // Check if status is "at_warehouse"
          if (data && data.status && data.status === 'at_warehouse') {
            // Find and update order
            const order = await Order.findOne({ trackingNumber: trackingNumber });
            
            if (order) {
              await Order.findByIdAndUpdate(
                order._id,
                { 
                  goRushStatus: 'collected',
                  updatedAt: new Date()
                },
                { new: true, runValidators: false }
              );
              
              // Add log entry
              const logEntry = {
                note: `Status automatically updated to 'collected' based on DeTrack status: ${data.tracking_status || data.status}`,
                category: 'system',
                createdBy: 'system',
                createdAt: new Date(),
              };
              
              order.logs.push(logEntry);
              await order.save();
              
              results.push({
                trackingNumber,
                status: 'updated',
                detrackStatus: data.status,
                newGoRushStatus: 'collected'
              });
            } else {
              results.push({
                trackingNumber,
                status: 'no_order_found',
                detrackStatus: data.status
              });
            }
          } else {
            results.push({
              trackingNumber,
              status: 'no_update_needed',
              detrackStatus: data.status
            });
          }
        } else {
          results.push({
            trackingNumber,
            status: 'detrack_error',
            error: `API error: ${response.status}`
          });
        }
      } catch (error) {
        results.push({
          trackingNumber,
          status: 'error',
          error: error.message
        });
      }
    }
    
    res.json({
      message: 'Bulk update completed',
      results,
      totalProcessed: trackingNumbers.length,
      successfulUpdates: results.filter(r => r.status === 'updated').length
    });
    
  } catch (error) {
    console.error('Error in bulk DeTrack update:', error);
    res.status(500).json({ 
      error: 'Failed to process bulk update',
      details: error.message 
    });
  }
});

cron.schedule('*/10 * * * *', async () => {
  console.log(`⏰ [CRON] Running scheduled DeTrack sync at ${new Date().toISOString()}`);
  try {
    const result = await syncDeTrackStatuses();
    console.log(`✅ [CRON] Scheduled sync completed. Updated ${result.updatedCount || 0} orders.`);
    
    if (result.updatedCount > 0) {
      console.log(`📊 [CRON] Sync summary: ${result.updatedCount} orders updated to 'collected'`);
    } else {
      console.log(`ℹ️ [CRON] No orders needed status updates`);
    }
  } catch (error) {
    console.error('❌ [CRON] Error in scheduled sync:', error);
  }
});


async function syncDeTrackStatuses() {
  try {
    // Get all orders with tracking numbers that don't have "collected" status
    const orders = await Order.find({
      doTrackingNumber: { $exists: true, $ne: null },
      collectionDate: { $exists: true, $ne: null },
      goRushStatus: { $ne: 'collected' }
    }).limit(100);
    
    console.log(`🔄 Starting DeTrack sync for ${orders.length} orders`);
    
    let updatedCount = 0;
    let apiCalls = 0;
    let statusMatches = 0;
    
    for (const order of orders) {
      try {
        console.log(`🔍 Processing order ${order._id} with tracking ${order.doTrackingNumber}`);
        
        apiCalls++;
        const response = await fetch(`https://app.detrack.com/api/v2/dn/jobs/show/?do_number=${order.doTrackingNumber}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': process.env.DETRACK_API_KEY || 'Ude778d93ebd628e6c942a4c4f359643e9cefc1949b17d433'
          }
        });
        
        if (!response.ok) {
          console.error(`❌ API error for ${order.doTrackingNumber}: ${response.status}`);
          continue;
        }
        
        const { data } = await response.json();
        console.log(`📦 DeTrack response for ${order.doTrackingNumber}:`, {
          status: data?.status,
          tracking_status: data?.tracking_status,
          primary_job_status: data?.primary_job_status,
          milestones: data?.milestones?.map(m => m.status)
        });
        
const statusIndicators = [
  data?.status,
  data?.tracking_status,
  data?.primary_job_status,
  ...(data?.milestones || []).map(m => m.status)
].filter(Boolean);

console.log(`🔍 Status indicators found:`, statusIndicators);
        
        console.log(`🔍 Status indicators found:`, statusIndicators);
        
const isAtWarehouse = statusIndicators.some(status => {
  const normalizedStatus = String(status).toLowerCase();
  return (
    normalizedStatus.includes('warehouse') ||
    normalizedStatus.includes('delivered') ||
    normalizedStatus.includes('completed') ||
    normalizedStatus.includes('collected') ||
    normalizedStatus === 'at_warehouse' ||
    normalizedStatus === 'out_for_delivery' ||
    normalizedStatus === 'head_to_delivery'
  );
});

const hasWarehouseMilestone = data?.milestones && data.milestones.includes('at_warehouse');

        
const hasWarehouseTimestamp = data?.at_warehouse_at !== null && data?.at_warehouse_at !== undefined;

console.log(`🔍 Warehouse checks:`, {
  isAtWarehouse,
  hasWarehouseMilestone, 
  hasWarehouseTimestamp,
  atWarehouseTimestamp: data?.at_warehouse_at
});
        
if (isAtWarehouse || hasWarehouseMilestone || hasWarehouseTimestamp) {
  statusMatches++;
  console.log(`✅ Found confirmed warehouse/delivered status for ${order.doTrackingNumber}`);
          
          // Update order status
          const updateData = {
            goRushStatus: 'collected',
            updatedAt: new Date()
          };
          
          // Add detrack data for reference
          if (data) {
            updateData.detrackData = {
              status: data.status,
              trackingStatus: data.tracking_status,
              primaryStatus: data.primary_job_status,
              milestones: data.milestones,
              lastUpdated: new Date()
            };
          }
          
          await Order.findByIdAndUpdate(
            order._id,
            updateData,
            { new: true, runValidators: false }
          );
          
          // Add log entry
          const logEntry = {
            note: `Status updated to 'collected' based on DeTrack status: ${statusIndicators.join(', ')}`,
            category: 'system',
            createdBy: 'system',
            createdAt: new Date(),
          };
          
          await Order.findByIdAndUpdate(
            order._id,
            { $push: { logs: logEntry } },
            { new: true }
          );
          
          updatedCount++;
          console.log(`✅ Updated order ${order._id} to collected`);
        } else {
          console.log(`ℹ️ Status not indicating warehouse for ${order.doTrackingNumber}`);
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`❌ Error syncing order ${order._id}:`, error.message);
      }
    }
    
    console.log(`📊 Sync summary:
    - API calls made: ${apiCalls}
    - Orders with warehouse status: ${statusMatches}
    - Orders updated: ${updatedCount}`);
    
    return { 
      success: true, 
      updatedCount,
      apiCalls,
      statusMatches
    };
    
  } catch (error) {
    console.error('❌ Error in DeTrack sync:', error);
    return { 
      success: false, 
      error: error.message,
      stack: error.stack 
    };
  }
}

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Endpoint to manually trigger sync
app.post('/api/detrack/sync', async (req, res) => {
  try {
    const result = await syncDeTrackStatuses();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
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