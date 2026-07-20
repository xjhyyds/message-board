const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { authMiddleware, adminMiddleware, JWT_SECRET } = require('./auth');

const app = express(), server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;
app.use(cors()); app.use(express.json({ limit: '3mb' }));

let onlineUsers = 0, editingMap = {}, recentOps = [], msgVersions = {}, socketUsers = {};
const HOT_THRESHOLD = 5;
function notifyAdmin(event, data) { for (const [sid, u] of Object.entries(socketUsers)) { if (u.role === 'admin') { const s = io.sockets.sockets.get(sid); if (s) s.emit(event, data); } } }

io.on('connection', (s) => {
  // Try extract user from handshake auth token
  try { const token = s.handshake.auth.token; if (token) { const u = jwt.verify(token, JWT_SECRET); s.user = u; socketUsers[s.id] = u; s.broadcast.emit('user_join', { username: u.username, role: u.role }); } } catch(e) {}

  onlineUsers++; io.emit('user_count', onlineUsers);
  // On reconnect, send recent ops for catch-up
  recentOps.slice(-30).forEach(op => s.emit(op.event, op.data));
  s.on('editing_start', (data) => {
    const key = data.messageId;
    if (!editingMap[key]) editingMap[key] = {};
    editingMap[key][s.id] = data.username;
    s.broadcast.emit('editing_status', { messageId: key, editors: Object.values(editingMap[key]), count: Object.keys(editingMap[key]).length });
  });
  s.on('editing_stop', (data) => {
    const key = data.messageId;
    if (editingMap[key]) { delete editingMap[key][s.id]; if (Object.keys(editingMap[key]).length === 0) delete editingMap[key]; }
    s.broadcast.emit('editing_status', { messageId: key, editors: editingMap[key] ? Object.values(editingMap[key]) : [], count: editingMap[key] ? Object.keys(editingMap[key]).length : 0 });
  });
  s.on('disconnect', () => {
    const u = socketUsers[s.id]; if (u) { s.broadcast.emit('user_leave', { username: u.username }); delete socketUsers[s.id]; }

    onlineUsers = Math.max(0, onlineUsers - 1); io.emit('user_count', onlineUsers);
    // Clean up editing map for disconnected socket
    Object.keys(editingMap).forEach(key => {
      if (editingMap[key][s.id]) { delete editingMap[key][s.id];
        if (Object.keys(editingMap[key]).length === 0) delete editingMap[key];
        else io.emit('editing_status', { messageId: parseInt(key), editors: Object.values(editingMap[key]), count: Object.keys(editingMap[key]).length });
      }
    });
  });
});
function pushOp(event, data) { recentOps.push({ event, data, ts: Date.now() }); if (recentOps.length > 100) recentOps.shift(); }

const SENSITIVE = ['fuck','shit','傻逼','妈的','操你','滚','垃圾网站','草泥马','法轮功'];
function filterSensitive(text) { let f = text; SENSITIVE.forEach(w => { f = f.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi'), '***'); }); return { filtered: f, hasSensitive: f !== text }; }
function extractUserId(req) { try { const h = req.headers.authorization; if (!h) return null; return jwt.verify(h.split(' ')[1], JWT_SECRET); } catch { return null; } }
async function logOp(username, action, target, detail) { try { await pool.query('INSERT INTO op_logs (username,action,target,detail) VALUES (?,?,?,?)', [username||'',action,target||'',(detail||'').slice(0,500)]); } catch {} }

// Rate limiter: prevent spam (3s cooldown per user)
const lastSubmit={};app.use('/messages',(req,res,next)=>{if(req.method==='POST'){const uid=(extractUserId(req)||{}).id||'anon',now=Date.now();if(lastSubmit[uid]&&now-lastSubmit[uid]<3000)return res.status(429).json({message:'请勿频繁提交'});lastSubmit[uid]=now}next()});

// ==================== Auth ====================
app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim(), password = String(req.body.password || '').trim(), className = String(req.body.className || '').trim(), studentId = String(req.body.studentId || '').trim(), isTeacher = !!req.body.isTeacher;
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ message: '用户名2-20位' });
  if (password.length < 6) return res.status(400).json({ message: '密码不少于6位' });
  try { const [e] = await pool.query('SELECT id FROM users WHERE username=?', [username]); if (e.length) return res.status(409).json({ message: '用户名已存在' });
    const [r] = await pool.query('INSERT INTO users (username,password,class_name,student_id,is_teacher) VALUES (?,?,?,?,?)', [username, await bcrypt.hash(password,10), className, studentId, isTeacher?1:0]);
    logOp(username, 'register', 'user', (isTeacher?'teacher':'student')+' id='+r.insertId); res.status(201).json({ id: r.insertId, username, role: 'user', isTeacher });
  } catch (err) { res.status(500).json({ message: '注册失败' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try { const [rows] = await pool.query('SELECT * FROM users WHERE username=?', [username]); if (!rows.length || !await bcrypt.compare(password, rows[0].password)) return res.status(401).json({ message: '用户名或密码错误' });
    const u = rows[0]; const token = jwt.sign({ id: u.id, username: u.username, role: u.role, isTeacher: !!u.is_teacher }, JWT_SECRET, { expiresIn: '24h' });
    logOp(u.username, 'login', 'user', ''); res.json({ token, user: { id: u.id, username: u.username, role: u.role, isTeacher: !!u.is_teacher, className: u.class_name, studentId: u.student_id } });
  } catch (err) { res.status(500).json({ message: '登录失败' }); }
});
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM users WHERE id=?', [req.user.id]); if (!rows.length) return res.status(404);
    const u = rows[0], [[mc]] = await pool.query('SELECT COUNT(*) AS c FROM messages WHERE user_id=?', [u.id]), [[rc]] = await pool.query('SELECT COUNT(*) AS c FROM reactions WHERE user_id=?', [u.id]);
    let badge = ''; if (mc.c >= 10) badge = '🏆'; else if (mc.c >= 5) badge = '⭐'; else if (mc.c >= 1) badge = '🌱';
    res.json({ id: u.id, username: u.username, role: u.role, className: u.class_name, studentId: u.student_id, isTeacher: !!u.is_teacher, created_at: u.created_at, messageCount: mc.c, reactionCount: rc.c, badge });
  } catch (err) { res.status(500).json({ message: '获取失败' }); }
});
app.put('/api/auth/password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) return res.status(400);
  try { const [rows] = await pool.query('SELECT password FROM users WHERE id=?', [req.user.id]); if (!await bcrypt.compare(oldPassword, rows[0].password)) return res.status(400).json({ message: '旧密码错误' });
    await pool.query('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(newPassword,10), req.user.id]); res.json({ message: '密码修改成功' });
  } catch (err) { res.status(500).json({ message: '修改失败' }); }
});

// ==================== Reports ====================
app.post('/messages/:id/report', authMiddleware, async (req, res) => {
  const msgId = parseInt(req.params.id), reason = String(req.body.reason || '').trim();
  if (!reason || reason.length > 300) return res.status(400).json({ message: '请填写举报理由(不超过300字)' });
  try { await pool.query('INSERT INTO reports (reporter_id,message_id,reason) VALUES (?,?,?)', [req.user.id, msgId, reason]);
    logOp(req.user.username, 'report', 'msg#'+msgId, reason); notifyAdmin('report_notify',{messageId:msgId,reason,reporter:req.user.username});res.json({ message: '举报已提交' });
  } catch (err) { res.status(500).json({ message: '举报失败' }); }
});
app.get('/api/reports', authMiddleware, adminMiddleware, async (req, res) => {
  try { const [rows] = await pool.query('SELECT r.id,r.reason,r.created_at,u.username AS reporter,m.content AS msg FROM reports r JOIN users u ON r.reporter_id=u.id JOIN messages m ON r.message_id=m.id ORDER BY r.id DESC'); res.json(rows); }
  catch (err) { res.status(500).json({ message: '获取失败' }); }
});
app.get('/api/logs', authMiddleware, adminMiddleware, async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM op_logs ORDER BY id DESC LIMIT 100'); res.json(rows); }
  catch (err) { res.status(500).json({ message: '获取失败' }); }
});

// ==================== Visit / Announcement ====================
app.post('/api/visit', (req, res) => { pool.query('INSERT INTO visits VALUES ()').then(() => pool.query('SELECT COUNT(*) AS c FROM visits').then(([[{c}]]) => res.json({ visits: c }))).catch(() => res.json({ visits: 0 })); });
app.get('/api/announcement', (req, res) => res.json({ text: process.env.ANNOUNCEMENT || '欢迎来到班级留言板实训项目！' }));
app.put('/api/announcement', authMiddleware, adminMiddleware, (req, res) => { const text = String(req.body.text || '').trim(); if(!text) return res.status(400); io.emit('announcement_update',{text}); pushOp('announcement',{text}); res.json({message:'公告已更新'}); });

// ==================== Stats / Users / Export ====================
app.get('/api/users', async (req, res) => {
  try { const [rows] = await pool.query('SELECT u.*,COUNT(DISTINCT m.id) AS mc,COUNT(DISTINCT r.id) AS rc FROM users u LEFT JOIN messages m ON u.id=m.user_id LEFT JOIN reactions r ON u.id=r.user_id GROUP BY u.id ORDER BY mc DESC'); res.json(rows); }
  catch (err) { res.status(500).json({ message: '获取失败' }); }
});
app.get('/api/stats', async (req, res) => {
  try { const [[{tU}]]=await pool.query('SELECT COUNT(*) AS tU FROM users'); const [[{tM}]]=await pool.query('SELECT COUNT(*) AS tM FROM messages'); const [[{tR}]]=await pool.query('SELECT COUNT(*) AS tR FROM reactions'); const [[{tRp}]]=await pool.query('SELECT COUNT(*) AS tRp FROM replies'); const [[{tV}]]=await pool.query('SELECT COUNT(*) AS tV FROM visits'); const [[{tD}]]=await pool.query("SELECT COUNT(*) AS tD FROM messages WHERE DATE(created_at)=CURDATE()"); const [top]=await pool.query('SELECT u.username,u.class_name,u.is_teacher,COUNT(m.id) AS c FROM users u LEFT JOIN messages m ON u.id=m.user_id GROUP BY u.id ORDER BY c DESC LIMIT 5'); const [rt]=await pool.query('SELECT type,COUNT(*) AS c FROM reactions GROUP BY type ORDER BY c DESC'); const [cats]=await pool.query("SELECT category,COUNT(*) AS c FROM messages WHERE category!='' GROUP BY category ORDER BY c DESC"); res.json({ totalUsers:tU,totalMessages:tM,totalReactions:tR,totalReplies:tRp,totalVisits:tV,todayMessages:tD,onlineUsers,topUsers:top,reactionTypes:rt,categories:cats }); }
  catch (err) { res.status(500); }
});
app.get('/api/export', authMiddleware, adminMiddleware, async (req, res) => {
  try { const fmt=req.query.format==='csv'?'csv':'json'; const [rows]=await pool.query('SELECT m.*,u.username,u.class_name,u.student_id FROM messages m LEFT JOIN users u ON m.user_id=u.id ORDER BY m.id');
    if(fmt==='csv'){let csv='\uFEFF"ID","用户","班级","学号","分类","内容","时间"\n';rows.forEach(r=>csv+='"'+(r.id||'')+'","'+(r.username||'')+'","'+(r.class_name||'')+'","'+(r.student_id||'')+'","'+(r.category||'')+'","'+((r.content||'').replace(/"/g,'""'))+'","'+(r.created_at||'')+'"\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename=messages.csv');res.send(csv)}else res.json(rows);
  } catch (err) { res.status(500); }
});
app.get('/api/messages/since', async (req, res) => { try { const [[{count}]]=await pool.query('SELECT COUNT(*) AS count FROM messages WHERE created_at > ?',[req.query.t||'1970-01-01']);res.json({count}); } catch { res.status(500); } });

// ==================== Messages ====================
app.get('/health', async (req, res) => { try { await pool.query('SELECT 1'); res.json({ status:'ok',db:'connected' }); } catch { res.status(503).json({ status:'error' }); } });
app.get('/messages', async (req, res) => {
  const page=Math.max(1,parseInt(req.query.page)||1),limit=Math.min(50,Math.max(1,parseInt(req.query.limit)||10)),offset=(page-1)*limit,search=(req.query.search||'').trim(),cat=(req.query.category||'').trim(),ids=(req.query.ids||'').split(',').filter(Boolean).map(Number);
  let sort='m.pinned DESC, m.id DESC'; if(req.query.sort==='popular')sort='totalReactions DESC, m.id DESC'; else if(req.query.sort==='oldest')sort='m.id ASC';
  let where='';let params=[];if(ids.length){where='WHERE m.id IN ('+ids.map(()=>'?').join(',')+')';params=ids}else{if(search){where+=(where?' AND ':'WHERE ')+'(m.content LIKE ? OR u.username LIKE ?)';params.push('%'+search+'%','%'+search+'%')}if(cat){where+=(where?' AND ':'WHERE ')+'m.category=?';params.push(cat)}}
  try{const[[{total}]]=await pool.query('SELECT COUNT(*) AS total FROM messages m LEFT JOIN users u ON m.user_id=u.id '+where,params);const user=extractUserId(req);const[rows]=await pool.query('SELECT m.id,m.content,m.created_at AS time,m.pinned,m.tag,m.category,m.user_id,COALESCE(u.username,"匿名用户") AS name,u.class_name,u.student_id,u.is_teacher,(SELECT COUNT(*) FROM reactions WHERE message_id=m.id) AS totalReactions,(SELECT COUNT(*) FROM reactions WHERE message_id=m.id AND type="like") AS lc,(SELECT COUNT(*) FROM reactions WHERE message_id=m.id AND type="heart") AS hc,(SELECT COUNT(*) FROM reactions WHERE message_id=m.id AND type="laugh") AS ac,(SELECT COUNT(*) FROM reactions WHERE message_id=m.id AND type="sad") AS sc,(SELECT COUNT(*) FROM reactions WHERE message_id=m.id AND type="fire") AS fc,(SELECT COUNT(*) FROM replies WHERE message_id=m.id) AS replyCount'+(user?',(SELECT GROUP_CONCAT(type) FROM reactions WHERE message_id=m.id AND user_id='+pool.escape(user.id)+') AS mr':',"" AS mr')+' FROM messages m LEFT JOIN users u ON m.user_id=u.id '+where+' GROUP BY m.id ORDER BY '+sort+' LIMIT ? OFFSET ?',[...params,limit,offset]);res.json({messages:rows,pagination:{page,limit,total,totalPages:Math.ceil(total/limit),hasMore:page*limit<total}})}catch(err){res.status(500)}
});
app.post('/messages', authMiddleware, async (req, res) => {
  let content=String(req.body.content||'').trim(),category=String(req.body.category||'').trim();if(!content||content.length>500)return res.status(400);const{filtered,hasSensitive}=filterSensitive(content);if(hasSensitive)return res.status(400).json({message:'内容包含敏感词'});
  try{const[[{c}]]=await pool.query('SELECT COUNT(*) AS c FROM messages WHERE user_id=?',[req.user.id]);const tag=c===0?'精选':'';const[r]=await pool.query('INSERT INTO messages (user_id,content,tag,category) VALUES (?,?,?,?)',[req.user.id,filtered,tag,category]);io.emit('new_message',{id:r.insertId,content:filtered,category,time:new Date().toISOString(),user_id:req.user.id,name:req.user.username,is_teacher:!!req.user.isTeacher});
      const mentions=filtered.match(/@(\\S+)/g);if(mentions){mentions.forEach(m=>{const target=m.slice(1);for(const[sid,u]of Object.entries(socketUsers)){if(u.username===target){const s=io.sockets.sockets.get(sid);if(s)s.emit('mention_notify',{from:req.user.username,messageId:r.insertId,snippet:filtered.slice(0,50)});}}});}logOp(req.user.username,'create','msg#'+r.insertId,'');res.status(201).json({id:r.insertId})}catch(err){res.status(500)}
});
app.put('/messages/:id', authMiddleware, async (req, res) => {
  const id=parseInt(req.params.id),content=String(req.body.content||'').trim();if(!content||content.length>500)return res.status(400);const{filtered,hasSensitive}=filterSensitive(content);if(hasSensitive)return res.status(400).json({message:'内容包含敏感词'});
  try{const[msgs]=await pool.query('SELECT user_id FROM messages WHERE id=?',[id]);if(!msgs.length)return res.status(404);if(msgs[0].user_id!==req.user.id&&req.user.role!=='admin')return res.status(403);await pool.query('UPDATE messages SET content=? WHERE id=?',[filtered,id]);logOp(req.user.username,'edit','msg#'+id,'');io.emit('message_edit',{id,content:filtered});pushOp('message_edit',{id,content:filtered});res.json({message:'已更新'})}catch(err){res.status(500)}
});
app.delete('/messages/:id', authMiddleware, adminMiddleware, async (req, res) => { try{const[r]=await pool.query('DELETE FROM messages WHERE id=?',[parseInt(req.params.id)]);if(!r.affectedRows)return res.status(404);logOp(req.user.username,'delete','msg#'+req.params.id,'');io.emit('message_delete',{id:parseInt(req.params.id)});pushOp('message_delete',{id:parseInt(req.params.id)});res.json({message:'已删除'})}catch(err){res.status(500)} });
app.post('/messages/batch-delete', authMiddleware, adminMiddleware, async (req, res) => { try{const ids=(req.body.ids||[]).filter(id=>!isNaN(parseInt(id)));if(!ids.length)return res.status(400).json({message:'请选择留言'});await pool.query('DELETE FROM messages WHERE id IN ('+ids.map(()=>'?').join(',')+')',ids);logOp(req.user.username,'batch-delete','msgs','count='+ids.length);io.emit('batch_delete',{ids});io.emit('global_notify',{msg:'管理员已批量清理'+ids.length+'条留言'});pushOp('batch_delete',{ids});res.json({message:'已删除'+ids.length+'条留言'})}catch(err){res.status(500)} });
app.post('/messages/batch-pin', authMiddleware, adminMiddleware, async (req, res) => { try{const ids=(req.body.ids||[]).filter(id=>!isNaN(parseInt(id)));if(!ids.length)return res.status(400);await pool.query('UPDATE messages SET pinned=1 WHERE id IN ('+ids.map(()=>'?').join(',')+')',ids);logOp(req.user.username,'batch-pin','msgs','count='+ids.length);io.emit('batch_pin',{ids});io.emit('global_notify',{msg:'管理员已批量置顶'+ids.length+'条留言'});pushOp('batch_pin',{ids});res.json({message:'已置顶'+ids.length+'条留言'})}catch(err){res.status(500)} });

// ==================== Replies / Reactions / Pin ====================
app.get('/messages/:id/replies', async (req, res) => { try{const[rows]=await pool.query('SELECT r.*,u.username,u.role,u.is_teacher,u.class_name FROM replies r JOIN users u ON r.user_id=u.id WHERE r.message_id=? ORDER BY r.id',[parseInt(req.params.id)]);res.json(rows)}catch(err){res.status(500)} });
app.post('/messages/:id/replies', authMiddleware, async (req, res) => { const msgId=parseInt(req.params.id),content=String(req.body.content||'').trim();if(!content||content.length>300)return res.status(400);const{filtered,hasSensitive}=filterSensitive(content);if(hasSensitive)return res.status(400);try{const[r]=await pool.query('INSERT INTO replies (user_id,message_id,content) VALUES (?,?,?)',[req.user.id,msgId,filtered]);io.emit('new_reply',{messageId:msgId,reply:{id:r.insertId,content:filtered,username:req.user.username}});logOp(req.user.username,'reply','msg#'+msgId,'');res.status(201).json({id:r.insertId})}catch(err){res.status(500)} });
app.put('/replies/:id', authMiddleware, async (req, res) => { const rid=parseInt(req.params.id),content=String(req.body.content||'').trim();if(!content||content.length>300)return res.status(400);try{const[reps]=await pool.query('SELECT user_id,message_id FROM replies WHERE id=?',[rid]);if(!reps.length)return res.status(404);if(reps[0].user_id!==req.user.id&&req.user.role!=='admin')return res.status(403);await pool.query('UPDATE replies SET content=? WHERE id=?',[content,rid]);io.emit('reply_edit',{id:rid,messageId:reps[0].message_id,content});pushOp('reply_edit',{id:rid,messageId:reps[0].message_id});res.json({message:'已更新'})}catch(err){res.status(500)} });
app.delete('/replies/:id', authMiddleware, async (req, res) => { try{const[reps]=await pool.query('SELECT user_id,message_id FROM replies WHERE id=?',[parseInt(req.params.id)]);if(!reps.length)return res.status(404);if(reps[0].user_id!==req.user.id&&req.user.role!=='admin')return res.status(403);await pool.query('DELETE FROM replies WHERE id=?',[parseInt(req.params.id)]);io.emit('reply_delete',{id:parseInt(req.params.id),messageId:reps[0].message_id});pushOp('reply_delete',{id:parseInt(req.params.id)});res.json({message:'已删除'})}catch(err){res.status(500)} });
app.post('/messages/:id/react', authMiddleware, async (req, res) => { const msgId=parseInt(req.params.id),type=req.body.type;if(!['like','heart','laugh','sad','fire'].includes(type))return res.status(400);try{const[e]=await pool.query('SELECT id FROM reactions WHERE user_id=? AND message_id=? AND type=?',[req.user.id,msgId,type]);if(e.length)await pool.query('DELETE FROM reactions WHERE id=?',[e[0].id]);else await pool.query('INSERT INTO reactions (user_id,message_id,type) VALUES (?,?,?)',[req.user.id,msgId,type]);const[counts]=await pool.query('SELECT type,COUNT(*) AS c FROM reactions WHERE message_id=? GROUP BY type',[msgId]);
      const totalReactions = counts.reduce((sum, r) => sum + r.c, 0); if (totalReactions >= HOT_THRESHOLD) io.emit('hot_tag', { messageId: msgId });const[mr]=await pool.query('SELECT type FROM reactions WHERE message_id=? AND user_id=?',[msgId,req.user.id]);io.emit('reaction_update',{messageId:msgId,counts,myReactions:mr.map(r=>r.type)});res.json({counts,myReactions:mr.map(r=>r.type)})}catch(err){res.status(500)} });
app.put('/messages/:id/pin', authMiddleware, adminMiddleware, async (req, res) => { try{const[msgs]=await pool.query('SELECT pinned FROM messages WHERE id=?',[parseInt(req.params.id)]);if(!msgs.length)return res.status(404);const v=msgs[0].pinned?0:1;await pool.query('UPDATE messages SET pinned=? WHERE id=?',[v,parseInt(req.params.id)]);logOp(req.user.username,v?'pin':'unpin','msg#'+req.params.id,'');io.emit('message_pin',{id:parseInt(req.params.id),pinned:!!v});pushOp('message_pin',{id:parseInt(req.params.id),pinned:!!v});res.json({pinned:!!v,message:v?'已置顶':'已取消置顶'})}catch(err){res.status(500)} });

async function start(){try{await pool.query('SELECT 1');console.log('DB OK');server.listen(port,()=>console.log('API+IO:'+port))}catch(e){console.error(e);process.exit(1)}}start();
