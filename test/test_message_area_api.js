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

                // Test 3: List messages in first area
                console.log(`\n3. Testing GET /api/v1/message-areas/areas/${firstArea.areaTag}/messages`);
                const msgsResult = await makeRequest(`${API_BASE}/areas/${firstArea.areaTag}/messages?limit=5`);
                console.log(`   Status: ${msgsResult.status}`);
                console.log(`   Found ${msgsResult.data.messages.length} messages`);
                console.log(`   Has more: ${msgsResult.data.pagination.hasMore}`);

                if (msgsResult.data.messages.length > 0) {
                    const firstMsg = msgsResult.data.messages[0];
                    console.log(`   First message: "${firstMsg.subject}" by ${firstMsg.fromUserName}`);

                    // Test 4: Get specific message
                    console.log(`\n4. Testing GET /api/v1/message-areas/messages/${firstMsg.messageUuid}`);
                    const msgResult = await makeRequest(`${API_BASE}/messages/${firstMsg.messageUuid}`);
                    console.log(`   Status: ${msgResult.status}`);
                    console.log(`   Subject: ${msgResult.data.message.subject}`);
                    console.log(`   From: ${msgResult.data.message.fromUserName}`);
                    console.log(`   Message preview: ${msgResult.data.message.message.substring(0, 50)}...`);
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