  const express = require("express");
  const path = require("path");
  const bodyParser = require("body-parser");
  const session = require("express-session");
  const dotenv = require("dotenv");
  const mongoose = require("mongoose");
  const app = express();
  const http = require("http").createServer(app);
  const jwt = require('jsonwebtoken');
  const cors = require("cors");
  const { Timestamp } = require('mongodb');

  const io = require("socket.io")(http, {
    cors: {
      origin: "*", 
      methods: ["GET", "POST"]
    }
  });

  dotenv.config();
  app.use(cors());
  app.use(express.json());

  // Import models
  const User = require("./src/api/models/userModelMessage.js");
  const Chat = require("./src/api/models/chatModelMesage.js");

  // Import routes
  const userRoutes = require("./src/api/routes/userMessRoutes.js");
  const uploadFileRoutes = require("./src/api/routes/uploadFileRoute.js");

  // Import other route files
  require("./src/api/routes/userRoute.js")(app);
  require("./src/api/routes/pollRoute.js")(app);
  require("./src/api/routes/projectRoute.js")(app);
  require("./src/api/routes/meetingRoute.js")(app);
  require("./src/api/routes/contactRoute.js")(app);
  require("./src/api/routes/meetingLinkRoute.js")(app);
  require("./src/api/routes/addAdminRoute.js")(app);
  require("./src/api/routes/moderatorInvitationRoute.js")(app);
  require("./src/api/routes/breakoutroomRoutes.js")(app);
  require("./src/api/routes/videoRoute.js")(app);
  require("./src/api/routes/companyRoute.js")(app);

  // Connect to MongoDB
  mongoose
    .connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
    .then(() => console.log("Database Connected"))
    .catch((error) => console.log("Database connection error:", error));

  const ChatMessageSchema = new mongoose.Schema({
    meetingId: {
      type: String,
      required: true
    },
    senderName: {
      type: String,
      required: true
    },
    receiverName: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true
    },
    timestamp: { type: Date, default: Date.now }
  });

  const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);
  app.use("/api", uploadFileRoutes);
  // Create a new namespace for participants
  const participantNamespace = io.of("/participant-namespace");

  let waitingRoom = {};
  let isMeetingStarted = {};
  let activeParticipants = {};

  participantNamespace.on("connection", (socket) => {
    console.log("Participant Connected:", socket.id);

    socket.on("joinMeeting", (user) => {
      console.log('user for joining meeting', user);
      socket.join(user.meetingId);
      
      if (!waitingRoom[user.meetingId]) {
        waitingRoom[user.meetingId] = [];
      }
      if (!activeParticipants[user.meetingId]) {
        activeParticipants[user.meetingId] = [];
      }

      if (user.role === "Participant") {
        const participantData = { ...user, socketId: socket.id };
        waitingRoom[user.meetingId].push(participantData);

        if (isMeetingStarted[user.meetingId]) {
          participantNamespace.to(user.meetingId).emit("newParticipantWaiting", participantData);
          console.log('New participant waiting:', participantData);
        }
      } else {
        // For non-participants (Moderator, Observer, Admin)
        activeParticipants[user.meetingId].push({ ...user, socketId: socket.id });
        participantNamespace.to(user.meetingId).emit("userJoined", { ...user, socketId: socket.id });
        
        console.log('activeParticipant', activeParticipants[user.meetingId]);

        participantNamespace.to(user.meetingId).emit("activeParticipantsUpdated", activeParticipants[user.meetingId]);
      }
    });

    socket.on("startMeeting", ({ meetingId }) => {
      isMeetingStarted[meetingId] = true;
      socket.join(meetingId);
      console.log(`Meeting started for ID: ${meetingId}. Current waiting room:`, waitingRoom[meetingId]);
      participantNamespace.to(meetingId).emit("meetingStarted", waitingRoom[meetingId]);
    });
    socket.on("sendMessage", async (data) => {
      console.log('send message data', data);
      
      const newMessage = new ChatMessage({
        ...data,
        timestamp: new Date()
      });
    
      try {
        await newMessage.save();
        const savedMessage = newMessage.toObject();
        savedMessage.timestamp = savedMessage.timestamp.toISOString();
        participantNamespace.to(data.meetingId).emit("newMessage", savedMessage);
        console.log('sending new message to the frontend', savedMessage);
      } catch (error) {
        console.error("Error saving message:", error);
      }
    });
    socket.on("getChatHistory", async (meetingId) => {
      try {
        const chatHistory = await ChatMessage.find({ meetingId }).sort('timestamp');
        console.log('chat history to send at front end', chatHistory);
        socket.emit("chatHistory", chatHistory);
      } catch (error) {
        console.error("Error fetching chat history:", error);
      }
    });

    socket.on("admitParticipant", (socketId) => {
      console.log('Attempting to admit participant with socketId:', socketId);
      let admittedParticipant;
      let meetingId;

      for (const [mId, waitingList] of Object.entries(waitingRoom)) {
        const participantIndex = waitingList.findIndex(p => p.socketId === socketId);
        if (participantIndex !== -1) {
          admittedParticipant = waitingList[participantIndex];
          meetingId = mId;
          waitingRoom[mId].splice(participantIndex, 1);
          break;
        }
      }

      if (admittedParticipant) {
        activeParticipants[meetingId].push(admittedParticipant);
        
        console.log('Participant admitted:', admittedParticipant);

        participantNamespace.to(meetingId).emit("participantAdmitted", admittedParticipant, isMeetingStarted[meetingId]);
        participantNamespace.to(meetingId).emit("activeParticipantsUpdated", activeParticipants[meetingId]);

        console.log('activeParticipant', activeParticipants[meetingId]);
      } else {
        console.log('Participant not found in waiting room');
      }
    });

    socket.on("leaveMeeting", (user) => {
      console.log('User leaving meeting:', user);

      if (activeParticipants[user.meetingId]) {
        activeParticipants[user.meetingId] = activeParticipants[user.meetingId].filter(p => p.socketId !== socket.id);
        
        participantNamespace.to(user.meetingId).emit("participantLeft", socket.id);
        
        console.log('Active participants after leave:', activeParticipants[user.meetingId]);

        participantNamespace.to(user.meetingId).emit("activeParticipantsUpdated", activeParticipants[user.meetingId]);
      }
    });

    socket.on("disconnect", () => {
      console.log('User disconnected:', socket.id);

      for (const [meetingId, participants] of Object.entries(activeParticipants)) {
        const updatedParticipants = participants.filter(p => p.socketId !== socket.id);
        if (updatedParticipants.length !== participants.length) {
          activeParticipants[meetingId] = updatedParticipants;
          participantNamespace.to(meetingId).emit("participantLeft", socket.id);
          console.log('Active participants after disconnect:', activeParticipants[meetingId]);
          participantNamespace.to(meetingId).emit("activeParticipantsUpdated", activeParticipants[meetingId]);
          break;
        }
      }
    });
  });

  // Start the server
  const PORT = process.env.PORT || 8008;
  http.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });