const { Timestamp } = require('mongodb');
const mongoose = require('mongoose');

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
module.exports=mongoose.model('Chat',ChatMessageSchema);