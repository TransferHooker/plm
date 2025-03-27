const express = require('express');
const { body, validationResult } = require('express-validator');
const validator = require('validator');

const {
  readJsonFile,
  writeJsonFile,
  USERS_FILE,
} = require('./balloon');

const router = express.Router();

router.put('/api/users/update-nickname', (req, res) => {
  const { wallet, newNickname, lastNicknameChange } = req.body;

  if (!wallet || !newNickname || !lastNicknameChange) {
    return res.status(400).json({ error: 'Wallet, newNickname, and lastNicknameChange are required' });
  }

  let users = readJsonFile(USERS_FILE);

  if (!users[wallet]) {
    return res.status(404).json({ error: 'Wallet address not found' });
  }

  users[wallet].nickname = newNickname;
  users[wallet].lastNicknameChange = lastNicknameChange;
  users[wallet].credits = 100; // Reset credits to 100 after nickname change

  writeJsonFile(USERS_FILE, users);

  res.json({ success: true, message: `Nickname updated to ${newNickname}` });
});

router.get('/api/users', (req, res) => {
  const users = readJsonFile(USERS_FILE);
  res.json(users);
});

router.get('/get_nickname', (req, res) => {
  const wallet = req.query.wallet;
  const users = readJsonFile(USERS_FILE);
  const user = users[wallet];
  if (user) {
    res.json({ success: true, nickname: user.nickname });
  } else {
    res.json({ success: false, message: 'User not found' });
  }
});

router.post('/test-sanitize', (req, res) => {
  console.log('Original input:', req.body);
  res.json({ sanitizedInput: req.body });
});

module.exports = router;