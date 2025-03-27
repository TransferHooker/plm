 require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const expressSanitizer = require('express-sanitizer');
const http = require('http');
const socketIo = require('socket.io');
const mongoSanitize = require('express-mongo-sanitize');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const solanaWeb3 = require('@solana/web3.js');

const ACTION_LOG_FILE = path.join(__dirname, 'actionlog.json');
const BALLOON_STATE_FILE = path.join(__dirname, 'balloonstate.json');
const COMMENTS_FILE = path.join(__dirname, 'comments.json');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, process.env.DATA_FILE || 'posts.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const HELIUS_RPC_URL = `https://devnet.helius-rpc.com/?api-key=07ed88b0-3573-4c79-8d62-3a2cbd5c141a`;
const RECEIVER_WALLET = 'AaWWHxaQHkiXq59Wz1CLeHFtMRuL46QiyMwfZooioFPD';


// Ensure files exist
if (!fs.existsSync(ACTION_LOG_FILE)) {
    fs.writeFileSync(ACTION_LOG_FILE, '[]');
}
if (!fs.existsSync(BALLOON_STATE_FILE)) {
    fs.writeFileSync(BALLOON_STATE_FILE, JSON.stringify({
    size: 0,
    lastPumpedBy: null,
    gameEnded: false,
}));
}
if (!fs.existsSync(COMMENTS_FILE)) {
    fs.writeFileSync(COMMENTS_FILE, '[]');
}

// Read comments from file
function readComments() {
    try {
        return JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8'));
    } catch (error) {
        console.error('Error reading comments:', error);
        return [];
    }
}

// Write comments to file
function writeComments(comments) {
    try {
        fs.writeFileSync(COMMENTS_FILE, JSON.stringify(comments, null, 2));
    } catch (error) {
        console.error('Error writing comments:', error);
    }
}

const logAction = (action) => {
    let actions = [];
    try {
        actions = JSON.parse(fs.readFileSync(ACTION_LOG_FILE, 'utf8'));
    } catch (error) {
        console.error('Error reading action log:', error);
    }
    
    // Add new action at the beginning of the array
    actions.unshift(action);
    
    try {
        fs.writeFileSync(ACTION_LOG_FILE, JSON.stringify(actions, null, 2)); // Write the updated actions array to the file
        io.emit('action_logged', action);
    } catch (error) {
        console.error('Error writing action log:', error);
    }
};

// Middleware
app.use(mongoSanitize());
app.use(express.json());
app.use(expressSanitizer());
app.use(cors());

// Rate limiting to prevent DDoS attacks
const limiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 1000 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Ensure files exist
function ensureFileExists(filePath, defaultContent = '{}') {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent);
    }
}

// Read data from a JSON file
function readJsonFile(filePath) {
    ensureFileExists(filePath);
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
        return {};
    }
}

// Write data to a JSON file
function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`Successfully wrote to ${filePath}`);
    } catch (error) {
        console.error(`Error writing to ${filePath}:`, error);
    }
}

// Generate a unique 24-character alphanumeric string
function generateUniqueIdentifier(existingIdentifiers) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let identifier;
    do {
        identifier = Array.from({ length: 24 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
    } while (existingIdentifiers.includes(identifier));
    return identifier;
}

// Generate a unique nickname
function generateUniqueNickname(existingNicknames) {
    let nickname;
    do {
        nickname = `User_${crypto.randomBytes(12).toString('hex')}`;
    } while (existingNicknames.includes(nickname));
    return nickname;
}

// Ensure files exist
ensureFileExists(DATA_FILE);
ensureFileExists(USERS_FILE, '{}');

const connectedUsers = {}; // Tracks connected users by session ID
let users = readJsonFile(USERS_FILE); // Load users from users.json
let balloonState = readJsonFile(BALLOON_STATE_FILE);

// Function to fetch SOL balance
const getBalance = async (publicKey) => {
    try {
        const connection = new solanaWeb3.Connection(HELIUS_RPC_URL, 'confirmed');
        const balanceInLamports = await connection.getBalance(new solanaWeb3.PublicKey(publicKey));
        const LAMPORTS_PER_SOL = 1_000_000_000;
        const balanceInSol = balanceInLamports / LAMPORTS_PER_SOL;
        return balanceInSol;
    } catch (err) {
        console.error('Failed to fetch balance:', err);
        return null;
    }
};

// Function to fetch latest blockhash
const fetchLatestBlockhash = async (connection, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const { blockhash: latestBlockhash } = await connection.getLatestBlockhash();
            return latestBlockhash;
        } catch (error) {
            console.error(`Attempt ${i + 1} - Failed to fetch latest blockhash:`, error);
            if (i === retries - 1) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
        }
    }
};

// Handle transactions
app.post('/api/transaction', async (req, res) => {
    const { walletAddress, solAmount, nickname } = req.body;

    if (!walletAddress || isNaN(solAmount) || solAmount <= 0) {
        return res.status(400).json({ error: 'Invalid transaction details' });
    }

    try {
        const connection = new solanaWeb3.Connection(HELIUS_RPC_URL, 'confirmed');
        const blockhash = await fetchLatestBlockhash(connection);

        const transaction = new solanaWeb3.Transaction({
            recentBlockhash: blockhash,
            feePayer: new solanaWeb3.PublicKey(walletAddress),
        }).add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: new solanaWeb3.PublicKey(walletAddress),
                toPubkey: new solanaWeb3.PublicKey(RECEIVER_WALLET),
                lamports: solAmount * solanaWeb3.LAMPORTS_PER_SOL,
            })
        );

        // Assuming the wallet is already connected and can sign the transaction
        const signedTransaction = await wallet.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signedTransaction.serialize());

        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) {
            throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
        }

        // Log the transaction
        const transactionData = {
            gameId: 1, // Assuming a single game ID for simplicity
            wallet: walletAddress,
            nickname: nickname || 'Anonymous',
            action: `Pumped (${solAmount.toFixed(8)} SOL)`,
            transactionSignature: signature, // Include the transaction signature
            timestamp: new Date().toISOString()
        };
        logAction(transactionData);

        res.json({ success: true, signature });

    } catch (error) {
        console.error('Failed to initiate transaction:', error);
        res.status(500).json({ error: 'Transaction failed' });
    }
});

// WebSocket connection handler
io.on('connection', (socket) => {
    console.log('New client connected');

    // Load and send the action log, balloon state, and comments to the client
    try {
        const actions = JSON.parse(fs.readFileSync(ACTION_LOG_FILE, 'utf8'));
        const comments = readComments();
        socket.emit('load_initial_state', { actions, balloonState, comments });
    } catch (error) {
        console.error('Error loading initial state:', error);
        socket.emit('load_initial_state', { actions: [], balloonState, comments: [] });
    }

    // Handle new comment
    socket.on('new_comment', (comment) => {
        const comments = readComments();
        comments.push(comment);
        writeComments(comments);
        io.emit('new_comment', comment);
    });

    // Handle like comment
    socket.on('like_comment', (data) => {
        const comments = readComments();
        const comment = comments.find(c => c.timestamp === data.commentId);

        if (comment) {
            // Initialize likedBy array if it doesn't exist
            if (!comment.likedBy) {
                comment.likedBy = [];
            }

            // Check if the wallet has already liked the comment
            if (comment.likedBy.includes(data.wallet)) {
                console.log(`Wallet ${data.wallet} already liked comment ${data.commentId}`);
                return; // Prevent duplicate likes
            }

            // Add the wallet to the likedBy array and increment likes
            comment.likedBy.push(data.wallet);
            comment.likes += 1;

            writeComments(comments);
            io.emit('comment_liked', { commentId: data.commentId, likes: comment.likes, likedBy: comment.likedBy });
        }
    });

    // Handle new reply
    socket.on('new_reply', (data) => {
        const comments = readComments();
        const comment = comments.find(c => c.timestamp === data.commentId);
        if (comment) {
            comment.replies.push(data.reply);
            writeComments(comments);
            io.emit('new_reply', data);
        }
    });

    socket.on('save_user_data', (data) => {
        const { wallet } = data;
        if (typeof wallet !== 'string') {
            console.error('Invalid wallet address:', wallet);
            return;
        }

        users = readJsonFile(USERS_FILE);
        let user = users[wallet];

        if (!user) {
            const existingIdentifiers = Object.values(users).map(u => u.identifier);
            const existingNicknames = Object.values(users).map(u => u.nickname);
            const identifier = generateUniqueIdentifier(existingIdentifiers);
            const nickname = generateUniqueNickname(existingNicknames);

            user = {
                identifier,
                wallet,
                nickname,
                lastConnectionDate: new Date().toISOString(),
                lastNicknameChange: ''
            };

            users[wallet] = user;
            writeJsonFile(USERS_FILE, users);
        } else {
            user.lastConnectionDate = new Date().toISOString();
        }

        connectedUsers[socket.id] = user;
        console.log(`User data loaded: ${wallet} (Identifier: ${user.identifier}, Nickname: ${user.nickname})`);
        socket.emit('user_data', user);
    });
  // Relay the viewProfile event to all clients
// Relay the viewProfile event to the client that sent the request
  socket.on('viewProfile', (data) => {
    console.log(`Relaying viewProfile event for wallet: ${data.walletAddress}`);
    socket.emit('viewProfile', data); // Emit only to the client that sent the request
  });
    // Handle pump event from server
  socket.on('pump', async (data) => {
    const { wallet, gameId, amount, transactionSignature } = data; // Get the amount and transaction signature from the client
    const user = users[wallet];

	
    if (!user || balloonState.gameEnded) {
        console.log('User not found or game already ended:', wallet);
        return;
    }

    // Calculate 4.7% chance to pop the balloon
    const popChance = Math.random() * 100; // Random number between 0 and 100
    if (popChance < 0.7) {
        // Pop the balloon
        balloonState.gameEnded = true;
        balloonState.size = 0; // Set balloon size to 0
        writeJsonFile(BALLOON_STATE_FILE, balloonState);

        // Broadcast the balloon_popped event to all clients
        io.emit('balloon_popped', { gameId, wallet, nickname: user.nickname || 'Anonymous' });

        // Log the action with "+ popped"
        const action = {
            gameId,
            wallet,
            nickname: user.nickname || 'Anonymous',
            action: `Pumped + popped (${amount} SOL)`, // Log the transaction amount
            transactionSignature, // Include the transaction signature
            timestamp: new Date().toISOString()
        };
        logAction(action);

        // Start the restart countdown
        setTimeout(() => {
            balloonState.gameEnded = false;
            writeJsonFile(BALLOON_STATE_FILE, balloonState);
            io.emit('game_restarting', { message: 'Game restarting in 5 seconds...' });
        }, 5000);
    } else {
        // Normal pump action
        balloonState.size += 1;
        balloonState.lastPumpedBy = user.nickname;
        writeJsonFile(BALLOON_STATE_FILE, balloonState);

        const action = {
            gameId,
            wallet,
            nickname: user.nickname || 'Anonymous',
            action: `Pumped (${amount} SOL)`, // Log the transaction amount
            transactionSignature, // Include the transaction signature
            timestamp: new Date().toISOString()
        };
        logAction(action);

        // Broadcast the updated balloon size to all clients
        io.emit('update_balloon', balloonState);
    }
    // Fetch and broadcast the updated balance
    const balance1 = await getBalance(wallet);
    if (balance1 !== null) {
        io.emit('balance1_update', { balance1 });
    }
    // Fetch and broadcast the updated balance
    const balance = await getBalance(RECEIVER_WALLET);
    if (balance !== null) {
        io.emit('balance_update', { balance });
    }
});
    // Handle check_game_state event
    socket.on('check_game_state', (data, callback) => {
        // Send the current game state back to the client
        callback(balloonState);
    });

socket.on('dump', async (data) => {
    const { wallet, gameId, amount } = data; // Get the amount from the client
    const user = users[wallet];

    if (!user || balloonState.gameEnded) {
        console.log('User not found or game already ended:', wallet);
        return;
    }

    balloonState.size = Math.max(0, balloonState.size - 1);
    balloonState.lastPumpedBy = user.nickname;
    writeJsonFile(BALLOON_STATE_FILE, balloonState);

    const action = {
        gameId,
        wallet,
        nickname: user.nickname || 'Anonymous',
        action: `Dumped (${amount} SOL)`, // Log the transaction amount
        timestamp: new Date().toISOString()
    };
    logAction(action);

    // Broadcast the updated balloon size to all clients
    io.emit('update_balloon', balloonState);

    // Fetch and broadcast the updated balance
    const balance = await getBalance(RECEIVER_WALLET);
    if (balance !== null) {
        io.emit('balance_update', { balance });
    }
});

    socket.on('change_nickname', (data) => {
        const { wallet, newNickname } = data;
        const user = users[wallet];
        if (!user) {
            socket.emit('nickname_error', { message: 'User not found.' });
            return;
        }

        const timeSinceLastChange = user.lastNicknameChange ? 
            (Date.now() - new Date(user.lastNicknameChange)) / 1000 : Infinity;
        if (timeSinceLastChange < 17) {
            socket.emit('nickname_error', { 
                message: `You can only change your nickname once every 17 seconds. Please wait ${17 - Math.floor(timeSinceLastChange)} seconds.` 
            });
            return;
        }

        user.nickname = newNickname;
        user.lastNicknameChange = new Date().toISOString();
        users[wallet] = user;
        writeJsonFile(USERS_FILE, users);

        io.emit('nickname_changed', { wallet, newNickname });
        socket.emit('nickname_changed', { nickname: newNickname });
    });

    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        if (user) {
            console.log(`Client disconnected: ${user.wallet} (Identifier: ${user.identifier}, Nickname: ${user.nickname})`);
            delete connectedUsers[socket.id];
        }
    });
});

app.get('/api/users', (req, res) => {
    const users = readJsonFile(USERS_FILE);
    res.json(users);
});

app.put('/api/users/update-nickname', (req, res) => {
    const { wallet, newNickname, lastNicknameChange } = req.body;

    if (!wallet || !newNickname || !lastNicknameChange) {
        return res.status(400).json({ error: 'Wallet, newNickname, and lastNicknameChange are required' });
    }

    const users = readJsonFile(USERS_FILE);

    if (!users[wallet]) {
        return res.status(404).json({ error: 'Wallet address not found' });
    }

    users[wallet].nickname = newNickname;
    users[wallet].lastNicknameChange = lastNicknameChange;

    writeJsonFile(USERS_FILE, users);

    res.json({ success: true, message: `Nickname updated to ${newNickname}` });
});
app.put('/api/users/update-nickname1', (req, res) => {
    const { wallet, newNickname1, lastNicknameChange } = req.body;

    if (!wallet || !newNickname || !lastNicknameChange) {
        return res.status(400).json({ error: 'Wallet, newNickname, and lastNicknameChange are required' });
    }

    const users = readJsonFile(USERS_FILE);

    if (!users[wallet]) {
        return res.status(404).json({ error: 'Wallet address not found' });
    }

    users[wallet].identifier = newNickname1;
    users[wallet].lastNicknameChange = lastNicknameChange;

    writeJsonFile(USERS_FILE, users);

    res.json({ success: true, message: `Nickname updated to ${newNickname}` });
});
app.get('/get_nickname', (req, res) => {
    const wallet = req.query.wallet;
    const users = readJsonFile(USERS_FILE);
    const user = users[wallet];
    if (user) {
        res.json({ success: true, nickname: user.nickname });
    } else {
        res.json({ success: false, message: 'User not found' });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});