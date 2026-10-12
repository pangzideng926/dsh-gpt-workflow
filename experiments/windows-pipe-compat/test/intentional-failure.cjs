const {test}=require('node:test');
const assert=require('node:assert/strict');
test('expected-assertion-failure',()=>assert.equal(1,2));
