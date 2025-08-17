const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 5000;

const admin = require("firebase-admin");

require("dotenv").config();
const Stripe = require("stripe");
const stripe = Stripe(process.env.PAYMENT_KEY);

// middleware
app.use(cors());
app.use(express.json());

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// DB connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ucyzrcm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();

    const db = client.db("buildingsDB");
    const apartmentsCollection = db.collection("apartments");
    const agreementsCollection = db.collection("agreements");
    const usersCollection = db.collection("users");
    const announcementsCollection = db.collection("announcements");
    const couponsCollection = db.collection("coupons");
    const paymentsCollection = db.collection("payments");

    //custom middleware
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      console.log(authHeader);
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        console.log(error);
        return res.status(401).send({ message: "forbidden access 0" });
      }
    };

    //Admin JWT Validation
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access 1" });
      }
      next();
    };

    //Member JWT Validation
    const verifyMember = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      console.log(user);
      if (!user || user.role !== "member") {
        return res.status(403).send({ message: "forbidden access 2" });
      }
      next();
    };

    //user JWT Validation
    const verifyUser = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "user") {
        return res.status(403).send({ message: "forbidden access 3" });
      }
      next();
    };

    // 🏢 Get apartments with pagination and optional rent filtering
    app.get("/apartments", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 6;
      const skip = (page - 1) * limit;

      const minRent = parseInt(req.query.minRent);
      const maxRent = parseInt(req.query.maxRent);

      const query = {};
      if (!isNaN(minRent) && !isNaN(maxRent)) {
        query.rent = { $gte: minRent, $lte: maxRent };
      }

      const total = await apartmentsCollection.countDocuments(query);
      const apartments = await apartmentsCollection
        .find(query)
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({ total, apartments });
    });

    // 👤 Add or update user with default role
    app.post("/users", async (req, res) => {
      const userData = req.body;

      if (!userData.email) {
        return res.status(400).send({ message: "Email is required" });
      }
      const isExist = await usersCollection.findOne({email: userData.email})
      if(isExist) { 
        return res.send({success:true, message: "User already Exist"})
      }
      userData.role = userData.role || "user";

      const result = await usersCollection.updateOne(
        { email: userData.email },
        { $set: userData },
        { upsert: true }
      );

      res.send({ success: true, result });
    });

    // Get all users
    app.get("/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch users", error });
      }
    });
    // ✅ ✅ Get user role by email (for frontend useRole hook)
    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required." });
      }

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(200).send({ message: "User not found." });
      }
      console.log(user);

      res.send({ role: user.role || "user" });
    });

    // 🤝 Submit agreement request
    app.post("/agreements", async (req, res) => {
      const agreementData = req.body;
      const { email } = agreementData;

      if (!email) return res.status(400).send({ message: "Missing email." });

      const existing = await agreementsCollection.findOne({ email });
      if (existing)
        return res
          .status(400)
          .send({ message: "You have already made an agreement." });

      agreementData.status = "pending";
      agreementData.role = "user";
      agreementData.agreementTime = new Date();

      const result = await agreementsCollection.insertOne(agreementData);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // 📄 Get agreement by email
    app.get("/agreements/user/:email", async (req, res) => {
      const email = req.params.email;
      if (!email) return res.status(400).send({ message: "Missing email." });

      const agreements = await agreementsCollection.find({ email }).toArray();
      res.send(agreements);
    });

    // 🔄 Get all pending requests
    app.get(
      "/agreements/requests",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const requests = await agreementsCollection
          .find({
            status: "pending",
            // suite: 'available'
          })
          .toArray();
        res.send(requests);
      }
    );

    // ✅ Accept/Reject Agreement
    app.patch(
      "/agreements/requests/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { action, userEmail } = req.body;
        const newStatus = "checked";
        // const newSuite = "unavailable"
        console.log(action, userEmail)
        const result = await agreementsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: newStatus } } //, suite: newSuite
        );
        console.log(result);
        if (result.modifiedCount !== 1) {
          return res
            .status(400)
            .send({ message: "Failed to update agreement" });
        }

        // If accepted, promote user to member
        if (action === "accept" && userEmail) {
          await usersCollection.updateOne(
            { email: userEmail },
            { $set: { role: "member" } }
          );
        }
        // Get the agreement to fetch apartment info
        const agreement = await agreementsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (agreement) {
          const { apartmentNo, blockName, floor } = agreement;

          // Update apartment to unavailable
          await apartmentsCollection.updateOne(
            {
              apartmentNo,
              blockName,
              floor,
            },
            { $set: { status: "unavailable" } }
          );
        }
        res.send({ success: true });
      }
    );

    // 👥 Get all members
    app.get("/members", async (req, res) => {
      const members = await usersCollection.find({ role: "member" }).toArray();
      res.send(members);
    });

    // 🔧 Update member role
    app.patch(
      "/members/:email/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        const { role } = req.body;
        console.log(role);
        const result = await usersCollection.updateOne(
          { email },
          { $set: { role } }
        );
        res.send({ success: result.modifiedCount === 1 });
      }
    );

    // 📢 Add announcement
    app.post("/announcements", verifyFBToken, verifyAdmin, async (req, res) => {
      const announcement = req.body;
      announcement.createdAt = new Date();
      const result = await announcementsCollection.insertOne(announcement);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // 📢 Get all announcements
    app.get("/announcements",  async (req, res) => {
      const announcements = await announcementsCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.send(announcements);
    });

    // 💸 Add coupon
    app.post("/coupons", async (req, res) => {
      const coupon = req.body;
      const existing = await couponsCollection.findOne({
        couponCode: coupon.couponCode,
      });

      if (existing) {
        return res.status(400).send({ message: "Coupon code already exists." });
      }

      const result = await couponsCollection.insertOne(coupon);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // 🔖 Get all coupons
    app.get("/coupons", async (req, res) => {
      const coupons = await couponsCollection.find().toArray();
      res.send(coupons);
    });
    app.put(
      "/coupons/:id/availability",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { available } = req.body;

        try {
          const result = await couponsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { available: available } }
          );

          if (result.modifiedCount === 1) {
            res.send({ success: true, message: "Availability updated" });
          } else {
            res
              .status(404)
              .send({ success: false, message: "Coupon not found" });
          }
        } catch (error) {
          res
            .status(500)
            .send({ success: false, message: "Internal server error" });
        }
      }
    );
    app.put("/coupons/:code/deactivate", async (req, res) => {
      const { code } = req.params;

      const result = await couponsCollection.updateOne(
        { couponCode: code },
        { $set: { available: false } }
      );

      if (result.modifiedCount > 0) {
        res.send({ success: true, message: "Coupon deactivated." });
      } else {
        res
          .status(404)
          .send({
            success: false,
            message: "Coupon not found or already inactive.",
          });
      }
    });

    // 💳 Create Stripe Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      if (!amount) {
        return res.status(400).send({ message: "Amount is required." });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: parseInt(amount * 100),
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // 💰 Store payment data
    app.post("/payments", verifyFBToken, verifyMember, async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);
      res.send({ insertedId: result.insertedId });
    });

    app.get("/payments", verifyFBToken, verifyMember, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        return res
          .status(400)
          .send({ message: "Email query param is required." });
      }
      const payments = await paymentsCollection
        .find({ email })
        .sort({ date: -1 })
        .toArray();
      res.send(payments);
    });
    // Get payment history for a user
    app.get(
      "/payments/user/:email",
      verifyFBToken,
      verifyMember,
      async (req, res) => {
        const email = req.params.email;
        const payments = await paymentsCollection
          .find({ email })
          .sort({ date: -1 })
          .toArray();
        res.send(payments);
      }
    );

    // 📊 Admin stats
    app.get("/admin-stats", verifyFBToken, verifyAdmin, async (req, res) => {
      const totalRooms = await apartmentsCollection.countDocuments();
      const availableRooms = await apartmentsCollection.countDocuments({
        status: "available",
      });
      const unavailableRooms = await apartmentsCollection.countDocuments({
        status: { $ne: "available" },
      });
      const totalUsers = await usersCollection.countDocuments({ role: "user" });
      const totalMembers = await usersCollection.countDocuments({
        role: "member",
      });

      res.send({
        totalRooms,
        availableRooms,
        unavailableRooms,
        totalUsers,
        totalMembers,
      });
    });

    // 🟢 Connection confirmation
    // await client.db("admin").command({ ping: 1 });
    // console.log("Connected to MongoDB!");
  } finally {
    // keep connection alive
  }
}

run().catch(console.dir);

// Root check
app.get("/", (req, res) => {
  res.send("Building Management server is running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
