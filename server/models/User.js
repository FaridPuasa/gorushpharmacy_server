import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true }, // Added email field
  password: { type: String, required: true }, // hashed
  role: { type: String, required: true }, // e.g., gorush, jpmc, moh
  subrole: { type: String, required: true }, // e.g., admin, customer_service
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { 
  collection: 'appusers' // Explicitly set collection name
});

export default mongoose.model('User', userSchema);