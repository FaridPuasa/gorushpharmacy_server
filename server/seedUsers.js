import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from './models/User.js';

dotenv.config();

const seedUsers = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const users = [
      {
        username: 'rushadmin',
        email: 'rushadmin@gorush.com',
        password: 'admin123',
        role: 'gorush',
        subrole: 'admin'
      },
      {
        username: 'rushcs',
        email: 'rushcs@gorush.com',
        password: 'cs123',
        role: 'gorush',
        subrole: 'customer_service'
      },
      {
        username: 'jpmcuser',
        email: 'jpmcuser@jpmc.com',
        password: 'jpmc123',
        role: 'jpmc',
        subrole: 'viewer'
      },
      {
        username: 'dylan',
        email: 'dylan@gorush.com',
        password: 'dylan123',
        role: 'gorush',
        subrole: 'admin'
      },
      {
        username: 'mohuser',
        email: 'mohuser@moh.gov',
        password: 'moh123',
        role: 'moh',
        subrole: 'viewer'
      }
    ];

    for (const user of users) {
      const exists = await User.findOne({ username: user.username });
      if (!exists) {
        const hashed = await bcrypt.hash(user.password, 10);
        await User.create({ ...user, password: hashed });
        console.log(`✅ Created user: ${user.username} in appusers collection`);
      } else {
        console.log(`⚠️ User already exists: ${user.username}`);
      }
    }

    console.log('🎉 Seeding completed successfully!');
  } catch (error) {
    console.error('❌ Error seeding users:', error.message);
  } finally {
    await mongoose.disconnect();
  }
};

seedUsers();