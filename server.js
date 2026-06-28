const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let lanes = {}; 

function getQueueStackCount(memberId) {
    if (!lanes[memberId] || !lanes[memberId].queueArray) return 0;
    return lanes[memberId].queueArray.reduce((a, b) => a + b, 0);
}

function startLaneCountdown(memberId) {
    if (!lanes[memberId] || lanes[memberId].isRunning) return;
    if (!lanes[memberId].queueArray || lanes[memberId].queueArray.length === 0) return;
    
    // 💡 ปรับปรุงตรงนี้: ดึงตั๋วก้อนแรกสุดในถาดออกมารันจับเวลาทันที
    const currentTicket = lanes[memberId].queueArray[0];
    lanes[memberId].tickets = currentTicket;
    lanes[memberId].totalSeconds = currentTicket * 30;
    
    lanes[memberId].isRunning = true;
    lanes[memberId].status = 'running';

    // ล้างตัวนับเวลาเก่าทิ้งก่อนเริ่มใหม่ป้องกันเวลาวิ่งซ้อนกัน
    if (lanes[memberId].intervalId) clearInterval(lanes[memberId].intervalId);

    lanes[memberId].intervalId = setInterval(() => {
        if (lanes[memberId].totalSeconds > 0) {
            lanes[memberId].totalSeconds--;
            if (lanes[memberId].totalSeconds <= 10 && lanes[memberId].totalSeconds > 0) {
                lanes[memberId].status = 'warning';
            }
        } else {
            // หมดเวลาคิวปัจจุบัน -> สลัดตั๋วก้อนแรกออกจากถาด
            lanes[memberId].queueArray.shift();
            
            const timeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            lanes[memberId].historyLog.unshift(`[${timeStr}] คุยเสร็จแล้ว: ${currentTicket} ใบ`);
            if(lanes[memberId].historyLog.length > 10) lanes[memberId].historyLog.pop();

            clearInterval(lanes[memberId].intervalId);
            lanes[memberId].isRunning = false;
            lanes[memberId].status = 'timeout';
            lanes[memberId].tickets = 0;
            lanes[memberId].totalSeconds = 0;
        }

        broadcastLaneUpdate(memberId);
    }, 1000);
}

function broadcastLaneUpdate(memberId) {
    if (!lanes[memberId]) return;
    const totalStack = getQueueStackCount(memberId);

    io.emit('lane_updated', {
        memberId: memberId,
        data: { 
            totalSeconds: lanes[memberId].totalSeconds, 
            status: lanes[memberId].status, 
            tickets: lanes[memberId].tickets,
            queueArray: lanes[memberId].queueArray,
            queueStack: totalStack, 
            historyLog: lanes[memberId].historyLog
        }
    });
}

io.on('connection', (socket) => {
    let initData = {};
    Object.keys(lanes).forEach(id => {
        initData[id] = { ...lanes[id], queueStack: getQueueStackCount(id) };
    });
    socket.emit('init_all_lanes', initData);

    socket.on('add_to_stack', (data) => {
        const { memberId, tickets, name } = data;
        if (!lanes[memberId]) {
            lanes[memberId] = { name, totalSeconds: 0, isRunning: false, tickets: 0, status: 'idle', queueArray: [], historyLog: [], intervalId: null };
        }
        lanes[memberId].queueArray.push(tickets);
        broadcastLaneUpdate(memberId);
    });

    socket.on('remove_from_stack', (data) => {
        const { memberId, tickets } = data;
        if (lanes[memberId] && lanes[memberId].queueArray.length > 0) {
            let lastIdx = lanes[memberId].queueArray.length - 1;
            lanes[memberId].queueArray[lastIdx] -= tickets;
            if (lanes[memberId].queueArray[lastIdx] <= 0) lanes[memberId].queueArray.pop();
            broadcastLaneUpdate(memberId);
        }
    });

    socket.on('remove_piece_from_stack', (data) => {
        const { memberId, index } = data;
        if (lanes[memberId] && lanes[memberId].queueArray[index] !== undefined) {
            lanes[memberId].queueArray.splice(index, 1);
            broadcastLaneUpdate(memberId);
        }
    });

    // 💡 แก้ไขจุดนี้ให้แมตช์กัน: รับแค่ไอดีมาแล้วสั่งให้ฟังก์ชันรันเวลาทำงานได้ทันที
    socket.on('trigger_manual_start', (data) => {
        const { memberId } = data;
        if (lanes[memberId] && lanes[memberId].queueArray.length > 0 && !lanes[memberId].isRunning) {
            startLaneCountdown(memberId);
        }
    });

    socket.on('pause_queue', (data) => {
        if (lanes[data.memberId] && lanes[data.memberId].isRunning) {
            clearInterval(lanes[data.memberId].intervalId);
            lanes[data.memberId].isRunning = false;
            lanes[data.memberId].status = 'paused';
            broadcastLaneUpdate(data.memberId);
        }
    });

    socket.on('reset_queue', (data) => {
        const { memberId } = data;
        if (lanes[memberId]) { clearInterval(lanes[memberId].intervalId); delete lanes[memberId]; }
        io.emit('lane_reseted', { memberId });
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });