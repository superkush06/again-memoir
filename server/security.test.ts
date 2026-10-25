import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigin } from './origin.js';
import { allowedSocialMediaUrl, publicAddress, downloadSocialMedia } from './media.js';

test('development proxy accepts loopback aliases, production rejects them without configured origin', () => {
  assert.equal(allowedOrigin('http://localhost:5173', '127.0.0.1:3001', {}), true);
  assert.equal(allowedOrigin('http://localhost:5173', '127.0.0.1:3001', { NODE_ENV: 'production' }), false);
  assert.equal(allowedOrigin('https://memoir.example', '127.0.0.1:3001', { NODE_ENV: 'production', APP_ORIGIN: 'https://memoir.example' }), true);
  assert.equal(allowedOrigin('https://memoir.example.attacker.test', '127.0.0.1:3001', { APP_ORIGIN: 'https://memoir.example' }), false);
  assert.equal(allowedOrigin('null', '127.0.0.1:3001', {}), false);
});

test('social archive refuses arbitrary hosts, deceptive suffixes, credentials, and private IP addresses', async () => {
  assert.equal(allowedSocialMediaUrl('https://scontent-lax3-1.cdninstagram.com/photo.jpg'), true);
  assert.equal(allowedSocialMediaUrl('https://instagram.fabc1-1.fna.fbcdn.net/video.mp4'), true);
  for (const value of [
    'http://scontent.cdninstagram.com/photo.jpg',
    'https://cdninstagram.com.attacker.test/photo.jpg',
    'https://attacker-cdninstagram.com/photo.jpg',
    'https://scontent.cdninstagram.com:8443/photo.jpg',
    'https://user:password@scontent.cdninstagram.com/photo.jpg',
    'https://127.0.0.1/private',
    'file:///etc/passwd',
  ]) {
    assert.equal(allowedSocialMediaUrl(value), false);
    await assert.rejects(downloadSocialMedia(value), /outside supported/);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1234', 'fc00::1234']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
