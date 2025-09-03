import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import compression from 'compression';
import authRoutes from './routes/auth.js';
import cron from 'node-cron';
import dayjs from 'dayjs';
import axios from 'axios';
import moment from 'moment';
import NodeCache from 'node-cache';

dotenv.config();

const app = express();

// Initialize cache with 60-second TTL
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Enhanced CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://grpharmacyappfrontend.vercel.app',
    'https://pharmacy.gorushbn.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Role'],
  credentials: true
};

app.use(cors(corsOptions)); // Apply CORS with options
app.options('*', cors(corsOptions)); // Enable preflight for all routes

app.use(compression());

app.use(express.json({ limit: '50mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const uri = process.env.MONGO_URI;

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log("✅ MongoDB connected");
    // Run initial collection date sync
    await initializeCollectionDateSync();
  })
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

const dmsFormSchema = new mongoose.Schema({
  formName: String,
  formDate: String,
  batchNo: String,
  startNo: String,
  endNo: String,
  creationDate: Date,
  mohForm: String,
  numberOfForms: String,
  formCreator: String,
  orderIds: [String],
  
  // Add these new fields to store the complete data for re-download
  previewData: {
    type: mongoose.Schema.Types.Mixed, // Stores the complete preview data as JSON
    required: true
  },
  htmlPreview: String, // Optional: Store HTML representation
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'forms' });

const DMSForm = mongoose.model('DMSForm', dmsFormSchema);

const getDateFilter = () => {
  return {
    $or: [
      {
        $and: [
          { product: 'pharmacymoh' },
          { creationDate: { $gte: '2025-08-06' } }
        ]
      },
      // All other product orders: from 11th July onwards  
      {
        $and: [
          { product: { $ne: 'pharmacymoh' } },
          { creationDate: { $gte: '2025-07-11' } }
        ]
      },
      // Handle orders without product field (legacy): from 11th July onwards
      {
        $and: [
          { product: { $exists: false } },
          { creationDate: { $gte: '2025-07-11' } }
        ]
      }
    ]
  };
};

// Helper function to generate cache keys
const generateCacheKey = (prefix, params) => {
  return `${prefix}_${JSON.stringify(params)}`;
};

// Clear cache for specific patterns
const clearCachePattern = (pattern) => {
  const keys = cache.keys();
  keys.forEach(key => {
    if (key.startsWith(pattern)) {
      cache.del(key);
    }
  });
};

// Add this to your server.js
app.put('/api/orders/:id/payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentAmount, doTrackingNumber } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    if (typeof paymentAmount !== 'number' || isNaN(paymentAmount)) {
      return res.status(400).json({ error: 'Valid payment amount is required' });
    }

    // First update our database
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { paymentAmount },
      { new: true }
    );

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

    // If we have a tracking number, update DeTrack
    if (doTrackingNumber) {
      try {
        const detrackRequestBody = {
          data: {
            payment_amount: paymentAmount
          }
        };

        const detrackResponse = await fetch(`https://app.detrack.com/api/v2/dn/jobs/update/?do_number=${doTrackingNumber}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': process.env.DETRACK_API_KEY || 'Ude778d93ebd628e6c942a4c4f359643e9cefc1949b17d433'
          },
          body: JSON.stringify(detrackRequestBody)
        });

        if (!detrackResponse.ok) {
          const errorText = await detrackResponse.text();
          console.error('DeTrack API error:', detrackResponse.status, errorText);
          return res.json({
            order: updatedOrder,
            detrackUpdate: false,
            message: 'Order updated but DeTrack update failed'
          });
        }

        const detrackData = await detrackResponse.json();
        console.log('DeTrack payment amount updated:', detrackData);
        
        return res.json({
          order: updatedOrder,
          detrackUpdate: true,
          detrackData
        });

      } catch (detrackError) {
        console.error('Error updating DeTrack payment amount:', detrackError);
        return res.json({
          order: updatedOrder,
          detrackUpdate: false,
          detrackError: detrackError.message
        });
      }
    }

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating payment amount:', error);
    res.status(500).json({ 
      error: 'Failed to update payment amount',
      details: error.message 
    });
  }
});

app.get('/api/orders/search', async (req, res) => {
  try {
    console.log('=== SEARCH REQUEST ===');
    console.log('Raw query params:', req.query);
    
    // Extract the search parameters directly from query
    const { patientNumber, icPassNum, receiverPhoneNumber } = req.query;
    
    // Determine which field was provided
    let field, value;
    if (patientNumber) {
      field = 'patientNumber';
      value = patientNumber;
    } else if (icPassNum) {
      field = 'icPassNum';
      value = icPassNum;
    } else if (receiverPhoneNumber) {
      field = 'receiverPhoneNumber';
      value = receiverPhoneNumber;
    } else {
      console.log('No valid search parameter provided');
      return res.status(400).json({ error: 'Please provide patientNumber, icPassNum, or receiverPhoneNumber' });
    }

    console.log(`Searching by ${field} = "${value}"`);

    // Create the query object
    const query = {};
    
    // For IC/Passport number, search both icPassNum and passport fields
    if (field === 'icPassNum') {
      query.$or = [
        { icPassNum: value },
        { passport: value }
      ];
    } else {
      query[field] = value;
    }

    console.log('MongoDB query:', JSON.stringify(query, null, 2));
    console.log('Collection name:', Order.collection.name);

    // First, let's check if there are any orders at all
    const totalOrders = await Order.countDocuments({});
    console.log(`Total orders in collection: ${totalOrders}`);

    // Search without date restrictions
    const orders = await Order.find(query)
      .sort({ creationDate: -1 })
      .limit(500)
      .lean(); // Use lean() for better performance

    console.log(`Found ${orders.length} matching orders`);
    
    if (orders.length > 0) {
      console.log('First matching order:', {
        _id: orders[0]._id,
        patientNumber: orders[0].patientNumber,
        icPassNum: orders[0].icPassNum,
        passport: orders[0].passport,
        receiverPhoneNumber: orders[0].receiverPhoneNumber,
        receiverName: orders[0].receiverName
      });
    }

    // If no results, let's check for similar values (case-insensitive search)
    if (orders.length === 0) {
      console.log('No exact matches found, trying case-insensitive search...');
      
      let caseInsensitiveQuery = {};
      if (field === 'icPassNum') {
        caseInsensitiveQuery.$or = [
          { icPassNum: { $regex: new RegExp(`^${value}$`, 'i') } },
          { passport: { $regex: new RegExp(`^${value}$`, 'i') } }
        ];
      } else {
        caseInsensitiveQuery[field] = { $regex: new RegExp(`^${value}$`, 'i') };
      }
      
      const caseInsensitiveResults = await Order.find(caseInsensitiveQuery)
        .sort({ creationDate: -1 })
        .limit(500)
        .lean();
        
      console.log(`Case-insensitive search found ${caseInsensitiveResults.length} orders`);
      
      if (caseInsensitiveResults.length > 0) {
        console.log('Note: Found results with case-insensitive search. Consider updating your search to be case-insensitive by default.');
      }
    }

    console.log('=== END SEARCH REQUEST ===\n');
    res.json(orders);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search orders' });
  }
});

app.post('/api/orders/reorder-webhook-only', async (req, res) => {
  try {
    const { originalOrderId, jobMethod, paymentMethod, remarks } = req.body;
    const userRole = req.headers['x-user-role'] || 'system';

    if (!mongoose.Types.ObjectId.isValid(originalOrderId)) {
      return res.status(400).json({ error: 'Invalid original order ID' });
    }

    // Find the original order
    const originalOrder = await Order.findById(originalOrderId);
    if (!originalOrder) {
      return res.status(404).json({ error: 'Original order not found' });
    }

    // Calculate delivery type and start date based on job method
    let deliveryTypeCode, startDate;
    if ((jobMethod == "Standard") || (jobMethod == "Self Collect")) {
      deliveryTypeCode = "STD";
      startDate = moment().add(2, 'days').format('YYYY-MM-DD');
    } else if (jobMethod == "Express") {
      deliveryTypeCode = "EXP";
      startDate = moment().add(1, 'day').format('YYYY-MM-DD');
    } else if (jobMethod == "Immediate") {
      deliveryTypeCode = "IMM";
      startDate = moment().format('YYYY-MM-DD');
    }

    // Function to calculate price based on job method
    const getPrice = (method) => {
      switch(method) {
        case 'Standard': return 10.00;
        case 'Express': return 15.00;
        case 'Same Day': 
        case 'Immediate': return 20.00;
        case 'Self Collect': return 5.00;
        default: return 10.00;
      }
    };

    // Prepare data for Make (formerly Integromat) - WEBHOOK ONLY, NO DATABASE SAVE
    const webhookData = {
      area: originalOrder.area,
      icNum: originalOrder.icNum,
      items: [
        {
          quantity: 1,
          description: "Medicine",
          totalItemPrice: getPrice(jobMethod)
        }
      ],
      remarks: remarks || '',
      passport: originalOrder.passport,
      attempt: 1,
      jobType: originalOrder.jobType,
      product: originalOrder.product,
      icPassNum: originalOrder.icPassNum,
      jobMethod: jobMethod || 'Standard',
      startDate,
      jobDate: "N/A",
      totalPrice: getPrice(jobMethod),
      dateOfBirth: originalOrder.dateOfBirth,
      sendOrderTo: originalOrder.sendOrderTo,
      creationDate: moment().format('YYYY-MM-DD'),
      receiverName: originalOrder.receiverName,
      trackingLink: "N/A",
      currentStatus: "Info Received",
      patientNumber: originalOrder.patientNumber,
      payingPatient: originalOrder.payingPatient,
      paymentamount: getPrice(jobMethod),
      paymentMethod: paymentMethod || 'Cash',
      receiverEmail: originalOrder.receiverEmail,
      warehouseEntry: "No",
      receiverAddress: originalOrder.receiverAddress,
      appointmentPlace: originalOrder.appointmentPlace,
      deliveryTypeCode,
      dateTimeSubmission: moment().utcOffset('+08:00').format('DD-MM-YYYY hh:mm a'),
      lastUpdateDateTime: moment().utcOffset('+08:00').format('DD-MM-YYYY hh:mm a'),
      receiverPostalCode: originalOrder.receiverPostalCode,
      appointmentDistrict: originalOrder.appointmentDistrict,
      pharmacyFormCreated: "No",
      receiverPhoneNumber: originalOrder.receiverPhoneNumber,
      additionalPhoneNumber: originalOrder.additionalPhoneNumber,
      warehouseEntryDateTime: "N/A",
      // Additional fields for webhook
      event: 'order_recreated',
      timestamp: new Date().toISOString(),
      originalOrderId: originalOrder._id,
      reorderSource: 'manual_reorder',
      processedBy: userRole
    };

    // WEBHOOK ONLY - No database operations
    if (!process.env.INTEGROMAT_WEBHOOK_URL) {
      return res.status(500).json({ 
        success: false,
        error: 'Webhook URL not configured',
        details: 'INTEGROMAT_WEBHOOK_URL environment variable is missing'
      });
    }

    // Trigger webhook to Make (Integromat)
    try {
      const webhookResponse = await axios.post(process.env.INTEGROMAT_WEBHOOK_URL, webhookData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Source': 'reorder-system'
        },
        timeout: 30000 // 30 second timeout
      });

      console.log('Webhook delivered successfully:', {
        status: webhookResponse.status,
        orderId: originalOrder._id,
        timestamp: new Date().toISOString()
      });

      res.status(200).json({
        success: true,
        message: 'Reorder webhook triggered successfully',
        webhookStatus: webhookResponse.status,
        data: {
          originalOrderId: originalOrder._id,
          patientNumber: originalOrder.patientNumber,
          jobMethod: jobMethod,
          paymentMethod: paymentMethod,
          totalPrice: getPrice(jobMethod),
          startDate: startDate,
          timestamp: webhookData.timestamp
        }
      });

    } catch (webhookError) {
      console.error('Webhook delivery failed:', {
        error: webhookError.message,
        orderId: originalOrder._id,
        timestamp: new Date().toISOString(),
        webhookUrl: process.env.INTEGROMAT_WEBHOOK_URL
      });

      res.status(500).json({ 
        success: false,
        error: 'Webhook delivery failed',
        details: webhookError.message,
        retryable: true
      });
    }

  } catch (error) {
    console.error('Error in reorder webhook endpoint:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Webhook processing failed'
    });
  }
});

app.put('/api/detrack/:trackingNumber/cancel', async (req, res) => {
  try {
    const { trackingNumber } = req.params;
    
    if (!trackingNumber) {
      return res.status(400).json({ error: 'Tracking number is required' });
    }

    console.log(`🔍 Cancelling DeTrack job for tracking number: ${trackingNumber}`);

    // Find the order first
    const order = await Order.findOne({ doTrackingNumber: trackingNumber });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // DeTrack API call with correct nested data structure - ONLY update tracking status
    const detrackRequestBody = {
      data: {
        tracking_status: 'Cancelled',  // Capitalized tracking status
        status: 'cancelled'            // Lowercase internal status
      }
    };

    console.log('DeTrack API Request:', {
      url: `https://app.detrack.com/api/v2/dn/jobs/update/?do_number=${trackingNumber}`,
      method: 'PUT',
      body: detrackRequestBody
    });

    const detrackResponse = await fetch(`https://app.detrack.com/api/v2/dn/jobs/update/?do_number=${trackingNumber}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.DETRACK_API_KEY || 'Ude778d93ebd628e6c942a4c4f359643e9cefc1949b17d433'
      },
      body: JSON.stringify(detrackRequestBody)
    });

    let detrackData = null;
    let detrackError = null;

    if (!detrackResponse.ok) {
      const errorText = await detrackResponse.text();
      console.error('DeTrack API error:', detrackResponse.status, errorText);
      detrackError = `DeTrack API error: ${detrackResponse.status} ${detrackResponse.statusText}`;
      
      // Log the error but don't fail the entire operation
      console.warn('DeTrack update failed but continuing with local cancellation');
    } else {
      try {
        detrackData = await detrackResponse.json();
        console.log('DeTrack update successful:', detrackData);
      } catch (parseError) {
        console.warn('Failed to parse DeTrack response, but status update may have succeeded');
      }
    }

    // Update the currentStatus and pharmacyFormCreated in our database
    const updateFields = { 
      currentStatus: 'Cancelled',
      updatedAt: new Date(),
      pharmacyFormCreated: 'Yes' // Add this field when cancelling
    };

    const updatedOrder = await Order.findByIdAndUpdate(
      order._id,
      updateFields,
      { new: true, runValidators: false } // Skip validation to avoid enum errors
    );

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

    // Add a log entry for this cancellation
    const logEntry = {
      note: detrackError 
        ? `DeTrack update failed: ${detrackError}. Order status updated locally to cancelled and marked as form created.` 
        : `DeTrack tracking status updated to 'Cancelled'. Order status updated locally to cancelled and marked as form created.`,
      category: 'Status Update',
      createdBy: req.headers['x-user-role'] || 'system',
      createdAt: new Date(),
    };

    updatedOrder.logs.push(logEntry);
    await updatedOrder.save();

    res.json({
      success: true,
      message: detrackError 
        ? 'Order cancelled locally and marked as form created, but DeTrack update failed' 
        : 'DeTrack tracking status updated to cancelled and order marked as form created',
      order: updatedOrder,
      detrackResponse: detrackData,
      detrackError: detrackError
    });

  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ 
      error: 'Failed to cancel order',
      details: error.message 
    });
  }
});

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
      $and: [
        { 
          $or: [
            { product: 'pharmacyjpmc' },
            { 
              $and: [
                { product: { $exists: false } },
                { creationDate: { $lt: new Date('2025-07-11') } }
              ]
            }
          ]
        },
        { 
          $or: [
            { doTrackingNumber: { $regex: /JP/i } },
            { doTrackingNumber: { $exists: false } } // Include orders without tracking number
          ]
        }
      ]
    };
  }

  if (role === 'gorush' || role === 'go-rush') {
    return {
      $and: [
        { 
          product: { 
            $in: ['pharmacyjpmc', 'pharmacymoh'] 
          } 
        },
        { 
          product: { 
            $nin: ['temu', 'kptdp', 'other_product'] 
          } 
        }
      ]
    };
  }

  return { product: 'pharmacyjpmc' };
}

function canAccessOrder(userRole, order) {
  const role = (userRole || '').toLowerCase().trim();
  
  // Go Rush can ONLY access pharmacy orders (both JPMC and MOH)
  if (role === 'gorush' || role === 'go-rush') {
    // Explicit check - only allow these two product types
    const allowedProducts = ['pharmacyjpmc', 'pharmacymoh'];
    return allowedProducts.includes(order.product);
  }
  
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
  
  // Go Rush can update Go Rush status ONLY on pharmacy orders
  if (updateType === 'goRushStatus') {
    if (role === 'gorush' || role === 'go-rush') {
      const allowedProducts = ['pharmacyjpmc', 'pharmacymoh'];
      return allowedProducts.includes(order.product);
    }
  }
  
  // Pharmacy status and remarks can only be updated by the appropriate pharmacy
  if (updateType === 'pharmacyStatus' || updateType === 'pharmacyRemarks') {
    if (role === 'moh') return order.product === 'pharmacymoh';
    if (role === 'jpmc') return order.product === 'pharmacyjpmc' || !order.product;
  }
  
  // Logs can be added by Go Rush ONLY on pharmacy orders
  if (updateType === 'logs') {
    if (role === 'gorush' || role === 'go-rush') {
      const allowedProducts = ['pharmacyjpmc', 'pharmacymoh'];
      return allowedProducts.includes(order.product);
    }
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

app.get('/api/orders/logs', async (req, res) => {
  try {
    const userRole = req.headers['x-user-role'];
    let query = {};
    
    // Apply role-based filtering
    if (userRole === 'jpmc') {
      query.product = 'pharmacyjpmc';
    } else if (userRole === 'moh') {
      query.product = 'pharmacymoh';
    }
    
    // Fetch orders with logs
    const orders = await Order.find(query)
      .sort({ creationDate: -1 })
      .lean();
    
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/gr_dms/saved-orders', async (req, res) => {
  try {
    const cacheKey = generateCacheKey('saved_orders', {});
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached saved orders data');
      return res.json(cachedData);
    }

    const savedOrders = await DMSForm.aggregate([
      { $unwind: "$orderIds" },
      { $group: { _id: null, orderIds: { $addToSet: "$orderIds" } } }
    ]);
    
    const orderIds = savedOrders.length > 0 ? savedOrders[0].orderIds : [];
    
    const result = { 
      success: true,
      orderIds 
    };
    
    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Error fetching saved orders:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch saved orders' 
    });
  }
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
    const cacheKey = generateCacheKey('orders', { role: req.userRole });
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached orders data');
      return res.json(cachedData);
    }

    const combinedFilter = getCombinedFilter(req.userRole);
    const queryOptions = getQueryOptions(req.userRole);

    const orders = await Order.find(combinedFilter)
      .sort(queryOptions.sort || {});
      
    // Get saved orders from DMS
    const savedOrders = await DMSForm.distinct('orderIds');
    
    // Add saved status to each order
    const ordersWithStatus = orders.map(order => ({
      ...order.toObject(),
      isSaved: savedOrders.includes(order._id.toString())
    }));

    cache.set(cacheKey, ordersWithStatus);
    res.json(ordersWithStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const cacheKey = generateCacheKey('customers', { role: req.userRole });
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached customers data');
      return res.json(cachedData);
    }

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
    
    cache.set(cacheKey, customers);
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customers/:patientNumber/orders', async (req, res) => {
  try {
    const { patientNumber } = req.params;
    const cacheKey = generateCacheKey('customer_orders', { 
      role: req.userRole, 
      patientNumber 
    });
    
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached customer orders data');
      return res.json(cachedData);
    }

    const combinedFilter = getCombinedFilter(req.userRole);
    
    let query = Order.find({ 
      ...combinedFilter,
      patientNumber: patientNumber 
    }).sort({ creationDate: -1 });
    
    const orders = await query;
    
    cache.set(cacheKey, orders);
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

    const updateData = {
      updatedAt: new Date(),
      collectionStatus: collectionStatus || 'pending'
    };

    if (collectionDate === null || collectionDate === '') {
      updateData.collectionDate = null;
    } 
    else if (collectionDate) {
      // Parse DD-MM-YYYY format correctly
      const [day, month, year] = collectionDate.split('-');
      
      // Create date in UTC to avoid timezone issues
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ 
          error: 'Invalid date format. Expected DD-MM-YYYY' 
        });
      }
      
      updateData.collectionDate = parsedDate;
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );

    // Clear relevant caches
    clearCachePattern('orders_');
    clearCachePattern('customers_');
    clearCachePattern('collection_dates_');

    // Return formatted date in response
    const responseData = updatedOrder.toObject();
    responseData.formattedCollectionDate = updatedOrder.collectionDate ? 
      dayjs(updatedOrder.collectionDate).format('DD-MM-YYYY') : 
      null;

    res.json(responseData);

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
    const cacheKey = generateCacheKey('collection_dates', {});
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached collection dates data');
      return res.json(cachedData);
    }

    const july2025 = new Date('2025-08-07T00:00:00Z');
    
    const dates = await Order.aggregate([
      { 
        $match: { 
          collectionDate: { 
            $exists: true, 
            $ne: null,
            $gte: july2025
          }
        } 
      },
      { 
        $project: {
          dateOnly: {
            $dateToString: { 
              format: "%Y-%m-%d", 
              date: "$collectionDate" 
            }
          }
        }
      },
      { 
        $group: {
          _id: "$dateOnly",
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const result = dates.map(d => ({
      dateString: d._id,
      count: d.count
    }));

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Error fetching collection dates:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/collection-dates', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    const cacheKey = generateCacheKey('orders_by_date', { 
      role: req.userRole, 
      date 
    });
    
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached orders by date data');
      return res.json(cachedData);
    }

    // Create start and end of day in UTC
    const startDate = new Date(date);
    startDate.setUTCHours(0, 0, 0, 0);
    
    const endDate = new Date(date);
    endDate.setUTCHours(23, 59, 59, 999);

    const combinedFilter = getCombinedFilter(req.headers['x-user-role']);
    
    const orders = await Order.find({
      collectionDate: {
        $gte: startDate,
        $lte: endDate
      },
      ...combinedFilter
    }).sort({ collectionDate: 1 });

    cache.set(cacheKey, orders);
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

    const cacheKey = generateCacheKey('order', { id });
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached order data');
      return res.json(cachedData);
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

    cache.set(cacheKey, order);
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
        const order = await Order.findOne({
          doTrackingNumber: trackingNumber
        });
        
        if (order) {
          if (order.goRushStatus === 'collected') {
            console.log(`ℹ️ Order already marked as collected, skipping update`);
            data.orderUpdated = false;
            data.message = 'Order already marked as collected';
          } else {
            // Update Go Rush status to "collected" WITHOUT adding a log
            const updatedOrder = await Order.findByIdAndUpdate(
              order._id,
              { 
                goRushStatus: 'collected',
                updatedAt: new Date()
              },
              { new: true, runValidators: false }
            );
            
            console.log(`✅ Updated Go Rush status to 'collected' for order: ${order._id}`);
            
            // Clear orders cache since we updated an order
            clearCachePattern('orders_');
            
            data.orderUpdated = true;
            data.updatedGoRushStatus = 'collected';
            data.orderId = order._id;
          }
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
              
              // Clear orders cache since we updated an order
              clearCachePattern('orders_');
              
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

cron.schedule('0 2 * * *', async () => {
      console.log(`🏠 [COLLECTION DATE CRON] Running daily MH/JP collection date sync at ${new Date().toISOString()}`);
  try {
    const result = await updateCollectionDatesFromDeTrack();
    console.log(`✅ [COLLECTION DATE CRON] Daily sync completed. Updated ${result.updatedCount || 0} collection dates.`);
    
    if (result.updatedCount > 0) {
      console.log(`📊 [COLLECTION DATE CRON] Sync summary: ${result.updatedCount} MH/JP orders updated with collection dates`);
    } else {
      console.log(`ℹ️ [COLLECTION DATE CRON] No MH/JP orders needed collection date updates`);
    }
  } catch (error) {
    console.error('❌ [COLLECTION DATE CRON] Error in scheduled collection date sync:', error);
  }
});

async function initializeCollectionDateSync() {
  console.log(`🏠 [STARTUP] Running initial MH/JP collection date sync on server start`);
  try {
    const result = await updateCollectionDatesFromDeTrack();
    console.log(`✅ [STARTUP] Initial MH/JP collection date sync completed. Updated ${result.updatedCount || 0} collection dates.`);
  } catch (error) {
    console.error('❌ [STARTUP] Error in initial MH/JP collection date sync:', error);
  }
}

async function syncDeTrackStatuses() {
  try {
    // Get all orders with tracking numbers that don't have "collected" status
    const orders = await Order.find({
      doTrackingNumber: { $exists: true, $ne: null },
      collectionDate: { $exists: true, $ne: null },
      goRushStatus: { $ne: 'collected' }
    }).limit(500);
    
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
          
          // Clear orders cache since we updated an order
          clearCachePattern('orders_');
          
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

async function updateCollectionDatesFromDeTrack() {
  try {
    console.log("🏁 Starting collection date update for MH/JP orders from 2025-07-11");

    // 1. Find all eligible orders - using string date comparison
    const orders = await Order.find({
      product: { $in: ['pharmacyjpmc', 'pharmacymoh'] },
      doTrackingNumber: { $exists: true, $ne: null },
      creationDate: { $gte: "2025-07-11" }, // Compare as string directly
      $or: [
        { collectionDate: { $exists: false } },
        { collectionDate: null },
        { collectionDate: "" }
      ]
    }).sort({ creationDate: 1 });

    console.log(`📊 Found ${orders.length} MH/JP orders needing collection dates`);

    let updatedCount = 0;
    let apiCalls = 0;
    let errors = 0;
    
    // 2. Process each order
    for (const order of orders) {
      try {
        apiCalls++;
        console.log(`🔍 Processing order ${order._id} with tracking ${order.doTrackingNumber}`);
        
        // Use the testSingleTrackingNumber logic
        const response = await fetch(`https://app.detrack.com/api/v2/dn/jobs/show/?do_number=${order.doTrackingNumber}`, {
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': process.env.DETRACK_API_KEY || 'Ude778d93ebd628e6c942a4c4f359643e9cefc1949b17d433'
          },
          timeout: 10000 // 10s timeout
        });
        
        if (!response.ok) {
          console.error(`❌ API error for ${order.doTrackingNumber}: ${response.status}`);
          errors++;
          continue;
        }
        
        const responseData = await response.json();
        const data = responseData.data || responseData; // Handle nested responses
        
        // 3. Extract all possible status indicators
        const statusIndicators = [
          data?.status,
          data?.tracking_status,
          ...(data?.milestones || []).map(m => m.status)
        ].filter(Boolean);
        
        console.log(`🔍 Status indicators for ${order.doTrackingNumber}:`, statusIndicators);
        
        // 4. Check for warehouse/delivered status (expanded check)
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
        
        // 5. Get warehouse timestamp (from milestones if available)
        const warehouseMilestone = (data?.milestones || []).find(m => 
          String(m?.status).toLowerCase().includes('warehouse')
        );
        
        const timestamp = warehouseMilestone?.pod_at || 
                         data?.at_warehouse_at || 
                         data?.completed_at || 
                         new Date().toISOString();
        
        if (isAtWarehouse) {
          // 6. Format collection date (UTC midnight)
          const collectionDate = new Date(timestamp).toISOString().split('T')[0] + 'T00:00:00.000Z';
          
          // 7. Update the order
          await Order.findByIdAndUpdate(
            order._id,
            { 
              collectionDate: new Date(collectionDate),
              collectionStatus: "collected",
              collectionDateSource: "detrack_auto_sync",
              updatedAt: new Date(),
              detrackData: { // Store tracking info for reference
                lastSync: new Date(),
                status: statusIndicators[0],
                sourceTimestamp: timestamp
              }
            },
            { new: true }
          );
          
          // Clear relevant caches
          clearCachePattern('orders_');
          clearCachePattern('customers_');
          clearCachePattern('collection_dates_');
          
          updatedCount++;
          console.log(`✅ Updated ${order.doTrackingNumber} (${order.product}): ${collectionDate}`);
        } else {
          console.log(`ℹ️ ${order.doTrackingNumber} not at warehouse (Status: ${statusIndicators[0] || 'unknown'})`);
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        errors++;
        console.error(`❌ Failed to process ${order.doTrackingNumber}:`, error.message);
      }
    }
    
    // 8. Final report
    console.log(`
    🎉 Sync Completed
    =================
    Total Orders: ${orders.length}
    API Calls: ${apiCalls}
    Updated: ${updatedCount}
    Errors: ${errors}
    Success Rate: ${Math.round((updatedCount/orders.length)*100)}%
    `);
    
    return { 
      success: true, 
      stats: {
        totalOrders: orders.length,
        updatedCount,
        apiCalls,
        errors
      }
    };
    
  } catch (error) {
    console.error("💥 Critical sync error:", error);
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

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

    res.json(updatedOrder);

  } catch (error) {
    console.error('Error updating Go Rush status:', error);
    res.status(500).json({ error: error.message });
  }
});

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

    const updateData = { 
      pharmacyStatus: status,
      updatedAt: new Date()
    };

    // If status is cancelled, also update currentStatus
    if (status.toLowerCase() === 'cancelled') {
      updateData.currentStatus = 'cancelled';
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: false }
    );

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

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

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

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

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

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

    // Clear orders cache since we updated an order
    clearCachePattern('orders_');

    res.status(201).json({ message: 'Remark added', remark: entry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// In your backend (server.js or routes file)
app.get('/api/gr_dms/forms', async (req, res) => {
  try {
    const cacheKey = generateCacheKey('dms_forms', {});
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached DMS forms data');
      return res.json(cachedData);
    }

    const forms = await DMSForm.find({
      // Filter MOH forms created on or after 30th July 2025
      $or: [
        { 
          mohForm: { $exists: true, $ne: null }, // MOH forms
          createdAt: { $gte: new Date('2025-08-06') } // From 30th July
        },
        { 
          mohForm: { $exists: false }, // Non-MOH forms (no date restriction)
        }
      ]
    })
    .select('formName formDate batchNo mohForm numberOfForms createdAt')
    .sort({ createdAt: -1 });
    
    const result = { success: true, forms };
    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Error fetching forms:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/gr_dms/forms/by-order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const cacheKey = generateCacheKey('dms_form_by_order', { orderId });
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached DMS form by order data');
      return res.json(cachedData);
    }

    console.log('API: Looking for orderId:', orderId);
    
    // Find form that contains this orderId in the orderIds array
    const form = await DMSForm.findOne({ 
      orderIds: { $in: [orderId] } // Use $in operator to search in array
    }).sort({ createdAt: -1 }).lean();
    
    console.log('API: Form found:', !!form);
    
    if (!form) {
      console.log('API: No form found for orderId:', orderId);
      return res.status(404).json({ 
        success: false,
        error: 'No form found containing this order' 
      });
    }

    console.log('API: Returning form with rows:', form.previewData?.rows?.length || 0);

    const result = {
      success: true,
      form: form
    };
    
    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.get('/api/gr_dms/forms/:formId', async (req, res) => {
  try {
    const { formId } = req.params;
    const cacheKey = generateCacheKey('dms_form', { formId });
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('📦 Returning cached DMS form data');
      return res.json(cachedData);
    }
    
    const form = await DMSForm.findById(formId);
    
    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found'
      });
    }
    
    const result = {
      success: true,
      form: form,
      previewData: form.previewData
    };
    
    cache.set(cacheKey, result);
    res.json(result);
    
  } catch (error) {
    console.error('Error fetching form:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Fixed POST endpoint for saving forms with order updates
app.post('/api/gr_dms/forms', async (req, res) => {
  try {
    const formData = req.body;
    
    // Validate required fields
    if (!formData.previewData || !formData.previewData.rows) {
      return res.status(400).json({ 
        success: false, 
        error: 'Preview data must include rows' 
      });
    }

    // Ensure all preview data fields exist and preserve rawData
    const completePreviewData = {
      rows: formData.previewData.rows.map(row => ({
        ...row,
        // Preserve the original rawData - this is crucial!
        rawData: row.rawData || row, // If rawData doesn't exist, use the row itself
        
        // Set display fields with proper fallbacks
        number: row.number || '',
        patientName: row.patientName || row.rawData?.receiverName || row.receiverName || 'N/A',
        trackingNumber: row.trackingNumber || row.rawData?.doTrackingNumber || row.doTrackingNumber || 'N/A',
        address: row.address || row.rawData?.receiverAddress || row.receiverAddress || 'N/A',
        deliveryCode: row.deliveryCode || getDeliveryCodePrefix(row.rawData?.jobMethod || row.jobMethod) || 'OTH',
        
        // Ensure we have a unique key
        key: row.key || row._id || row.rawData?._id || generateUniqueId()
      })),
      summary: formData.previewData.summary || {
        total: formData.orderIds?.length || formData.previewData.rows.length,
        deliveryMethod: formData.mohForm || 'Standard',
        batch: `B${formData.batchNo || 1} ${formData.startNo || 'S1'}-${formData.endNo || 'S' + (formData.orderIds?.length || formData.previewData.rows.length)}`,
        formDate: dayjs().format('DD.MM.YY')
      },
      meta: formData.previewData.meta || {
        jobMethod: formData.mohForm || 'Standard',
        batchNo: formData.batchNo || '1',
        startNo: formData.startNo || 'S1',
        endNo: formData.endNo || `S${formData.orderIds?.length || formData.previewData.rows.length}`,
        formDate: dayjs().format('DD.MM.YY')
      }
    };

    // Create new DMS form document
    const newForm = new DMSForm({
      formName: formData.formName,
      formDate: formData.formDate,
      batchNo: formData.batchNo,
      startNo: formData.startNo,
      endNo: formData.endNo,
      creationDate: new Date(),
      mohForm: formData.mohForm,
      numberOfForms: formData.numberOfForms || formData.orderIds?.length || completePreviewData.rows.length,
      formCreator: formData.formCreator,
      orderIds: formData.orderIds || [],
      previewData: completePreviewData,
      htmlPreview: formData.htmlPreview
    });

    // Save the form first
    const savedForm = await newForm.save();
    
    // Clear DMS forms cache since we added a new form
    clearCachePattern('dms_forms');
    clearCachePattern('saved_orders');
    
    // Extract tracking numbers from the form data
    const trackingNumbers = completePreviewData.rows
      .map(row => row.trackingNumber || row.rawData?.doTrackingNumber || row.doTrackingNumber)
      .filter(trackingNumber => trackingNumber && trackingNumber !== 'N/A');

    console.log('Updating orders for tracking numbers:', trackingNumbers);

    // Update orders collection - set pharmacyFormCreated to 'yes' for all matching tracking numbers
    if (trackingNumbers.length > 0) {
      const updateResult = await Order.updateMany(
        { doTrackingNumber: { $in: trackingNumbers } },
        { 
          $set: { 
            pharmacyFormCreated: 'Yes',
            formCreatedDate: new Date(),
            formId: savedForm._id // Optional: link back to the form
          } 
        }
      );
      
      console.log(`Updated ${updateResult.modifiedCount} orders with pharmacyFormCreated = 'yes'`);
      
      // Clear orders cache since we updated orders
      clearCachePattern('orders_');
      
      // Log any tracking numbers that weren't found
      if (updateResult.modifiedCount < trackingNumbers.length) {
        const updatedOrders = await Order.find(
          { doTrackingNumber: { $in: trackingNumbers } },
          { doTrackingNumber: 1 }
        );
        const updatedTrackingNumbers = updatedOrders.map(order => order.doTrackingNumber);
        const notFoundTrackingNumbers = trackingNumbers.filter(tn => !updatedTrackingNumbers.includes(tn));
        console.log('Tracking numbers not found in orders collection:', notFoundTrackingNumbers);
      }
    }
    
    res.status(201).json({ 
      success: true, 
      message: 'Form saved to DMS successfully and orders updated',
      form: savedForm,
      formId: savedForm._id,
      ordersUpdated: trackingNumbers.length > 0 ? true : false,
      trackingNumbersProcessed: trackingNumbers.length
    });
    
  } catch (error) {
    console.error('Error saving to DMS or updating orders:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Helper function to ensure unique IDs
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});