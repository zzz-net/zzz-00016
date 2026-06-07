const { initDb, getDb } = require('../db');

function seed() {
  initDb();
  const db = getDb();

  const existingUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (existingUsers.cnt > 0) {
    console.log('数据已存在，跳过初始化。如需重新初始化，请删除 data/school-bus.db 文件。');
    return;
  }

  const insertUser = db.prepare(`
    INSERT INTO users (username, name, role) VALUES (?, ?, ?)
  `);

  const users = [
    ['teacher_zhang', '张老师', 'teacher'],
    ['teacher_li', '李老师', 'teacher'],
    ['dispatcher_wang', '王调度', 'dispatcher'],
    ['safety_zhao', '赵安全员', 'safety'],
    ['admin_chen', '陈主任', 'admin']
  ];

  const tx = db.transaction((userList) => {
    for (const u of userList) {
      insertUser.run(...u);
    }
  });
  tx(users);

  console.log('初始化成功！创建了 5 个用户：');
  console.log('  teacher_zhang  张老师     (teacher  普通老师)');
  console.log('  teacher_li     李老师     (teacher  普通老师)');
  console.log('  dispatcher_wang 王调度     (dispatcher 调度)');
  console.log('  safety_zhao    赵安全员   (safety   安全员)');
  console.log('  admin_chen     陈主任     (admin    管理员)');
  console.log('');
  console.log('使用方式：请求头 X-User-Id 传对应用户 id（1-5）');
}

seed();
