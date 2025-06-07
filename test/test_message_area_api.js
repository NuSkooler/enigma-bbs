#!/usr/bin/env node
/* jslint node: true */
'use strict';

// Test script for Message Area Web API
// Run this after starting ENiGMA½ with the web server enabled

const http = require('http');

const API_HOST = 'localhost';
const API_PORT = 8080; // Default ENiGMA½ web server port
const API_BASE = '/api/v1/message-areas';

function makeRequest(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: API_HOST,
            port: API_PORT,
            path: path,
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, data: json });
                } catch (err) {
                    reject(new Error(`Failed to parse JSON: ${err.message}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.end();
    });
}

async function testAPI() {
    console.log('Testing ENiGMA½ Message Area Web API...\n');

    try {
        // Test 1: List conferences
        console.log('1. Testing GET /api/v1/message-areas/conferences');
        const confResult = await makeRequest(`${API_BASE}/conferences`);
        console.log(`   Status: ${confResult.status}`);
        console.log(`   Found ${confResult.data.conferences.length} conferences`);

        if (confResult.data.conferences.length > 0) {
            const firstConf = confResult.data.conferences[0];
            console.log(`   First conference: ${firstConf.name} (${firstConf.confTag})`);

            // Test 2: List areas in first conference
            console.log(`\n2. Testing GET /api/v1/message-areas/conferences/${firstConf.confTag}/areas`);
            const areasResult = await makeRequest(`${API_BASE}/conferences/${firstConf.confTag}/areas`);
            console.log(`   Status: ${areasResult.status}`);
            console.log(`   Found ${areasResult.data.areas.length} areas`);

            if (areasResult.data.areas.length > 0) {
                const firstArea = areasResult.data.areas[0];
                console.log(`   First area: ${firstArea.name} (${firstArea.areaTag})`);

                // Test message list without replies (default, faster)
                console.log('\n3. Testing message list (without replies):');
                const messagesResult = await makeRequest(`${API_BASE}/areas/${firstArea.areaTag}/messages?page=1&limit=5`);
                console.log(`   Status: ${messagesResult.status}`);
                if (messagesResult.status === 200) {
                    console.log(`   Found ${messagesResult.data.messages.length} messages`);
                    console.log(`   First message has replies field: ${messagesResult.data.messages[0] && 'replies' in messagesResult.data.messages[0]}`);

                    if (messagesResult.data.messages.length > 0) {
                        // Test specific message details (includes replies automatically)
                        console.log('\n4. Testing specific message details:');
                        const messageUuid = messagesResult.data.messages[0].messageUuid;
                        const messageResult = await makeRequest(`${API_BASE}/messages/${messageUuid}`);
                        console.log(`   Status: ${messageResult.status}`);
                        console.log(`   Message has replies field: ${'replies' in messageResult.data.message}`);
                        if (messageResult.data.message.replies) {
                            console.log(`   Reply count: ${messageResult.data.message.replies.length}`);
                        }

                        // Test message list WITH replies (slower but includes threading)
                        console.log('\n5. Testing message list (with replies):');
                        const messagesWithRepliesResult = await makeRequest(`${API_BASE}/areas/${firstArea.areaTag}/messages?page=1&limit=5&include_replies=true`);
                        console.log(`   Status: ${messagesWithRepliesResult.status}`);
                        if (messagesWithRepliesResult.status === 200) {
                            console.log(`   Found ${messagesWithRepliesResult.data.messages.length} messages`);
                            console.log(`   First message has replies field: ${messagesWithRepliesResult.data.messages[0] && 'replies' in messagesWithRepliesResult.data.messages[0]}`);
                            if (messagesWithRepliesResult.data.messages[0] && messagesWithRepliesResult.data.messages[0].replies) {
                                console.log(`   First message reply count: ${messagesWithRepliesResult.data.messages[0].replies.length}`);
                            }
                        }
                    }
                }
            }
        }

        // Test 5: Test error handling
        console.log('\n5. Testing error handling');
        console.log('   Testing non-existent conference...');
        const errorResult1 = await makeRequest(`${API_BASE}/conferences/nonexistent/areas`);
        console.log(`   Status: ${errorResult1.status} (expected 404)`);
        console.log(`   Error: ${errorResult1.data.message}`);

        console.log('\n   Testing non-existent message...');
        const errorResult2 = await makeRequest(`${API_BASE}/messages/00000000-0000-0000-0000-000000000000`);
        console.log(`   Status: ${errorResult2.status} (expected 404)`);
        console.log(`   Error: ${errorResult2.data.message}`);

        console.log('\nAll tests completed successfully!');
        
        console.log('\n\nTo test with the API disabled:');
        console.log('1. Set messageAreaApi: false in your config.hjson under contentServers.web');
        console.log('2. Restart ENiGMA½');
        console.log('3. Run this test again - all endpoints should return 404');

    } catch (err) {
        console.error(`\nError during testing: ${err.message}`);
        console.error('Make sure ENiGMA½ is running with the web server enabled on port 8080');
        process.exit(1);
    }
}

// Run tests
testAPI();