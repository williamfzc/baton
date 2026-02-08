#!/usr/bin/env node
import readline from 'node:readline/promises';
import { CommandDispatcher } from './core/dispatcher';
import type { IMMessage } from './types';

const projectPath = process.cwd();
const dispatcher = new CommandDispatcher(projectPath);

console.log('╔════════════════════════════════════════╗');
console.log('║           Baton CLI v0.1.0             ║');
console.log('║     ChatOps for Local Development      ║');
console.log('╚════════════════════════════════════════╝');
console.log(`\nProject: ${projectPath}\n`);

// 模拟 IM 消息循环
async function main() {
  console.log('Type your message (or command), or "quit" to exit:\n');
  
  const mockUserId = 'local-user';
  const mockUserName = 'Developer';

  // 使用 readline 读取用户输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const text = (await rl.question('> ')).trim();
    
    if (text.toLowerCase() === 'quit' || text.toLowerCase() === 'exit') {
      console.log('\n👋 Goodbye!');
      rl.close();
      process.exit(0);
    }

    if (!text) continue;

    const message: IMMessage = {
      userId: mockUserId,
      userName: mockUserName,
      text,
      timestamp: Date.now()
    };

    try {
      console.log('\n⏳ Processing...\n');
      const response = await dispatcher.dispatch(message);
      
      console.log('─'.repeat(50));
      console.log('📨 Response:');
      console.log(response.message);
      if (response.data) {
        console.log('\n📊 Data:', JSON.stringify(response.data, null, 2));
      }
      console.log('─'.repeat(50));
      console.log();
    } catch (error) {
      console.error('❌ Error:', error);
    }
  }
}

main().catch(console.error);