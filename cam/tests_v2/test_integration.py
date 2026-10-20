"""Source-level IDF integration guards; NOT a substitute for an IDF build."""
from pathlib import Path
import re
import unittest

MAIN = Path(__file__).parents[1] / 'main'
SRC = (MAIN / 'main.c').read_text()

class FirmwareIntegration(unittest.TestCase):
    def test_single_camera_no_pause(self):
        self.assertNotIn('CAMERA_RIGHT', SRC)
        self.assertNotIn('STREAM_PAUSED', SRC)
        self.assertIn('.camera_id = CAMERA_LEFT', SRC)

    def test_no_default_or_destructive_provisioning(self):
        self.assertNotIn('nvs_flash_erase(', SRC)
        self.assertNotIn('CAM_RECEIVER2', SRC)
        self.assertNotIn('12345678', SRC)
        self.assertIn('nvs_open("videx", NVS_READONLY', SRC)
        for key in ('ap_ssid', 'ap_pass', 'cam_token'):
            self.assertIn(f'"{key}"', SRC)
        self.assertIn('cam_credentials_valid(', SRC)

    def test_button_tasks_independent_capture_failure(self):
        self.assertIn('"button_sample"', SRC)
        self.assertIn('"button_sender"', SRC)
        sampler = SRC.split('static void button_sample_task(')[1].split('\nstatic ')[0]
        self.assertNotIn('esp_camera', sampler)
        self.assertNotIn('send(', sampler)
        self.assertIn('vTaskDelayUntil', sampler)
        self.assertIn('pdMS_TO_TICKS(20)', sampler)
        sender = SRC.split('static void button_sender_task(')[1].split('\nstatic ')[0]
        self.assertIn('connect_server(BUTTON_PORT)', sender)
        self.assertRegex(sender, r'credentials\.cam_token,\s*64')
        self.assertIn('cam_button_encode(', sender)
        self.assertIn('cam_send_until(', sender)
        self.assertLess(SRC.index('"button_sample"'), SRC.index('"camera"'))

    def test_bounded_image_send_and_fixed_destination(self):
        self.assertIn('#define SERVER_IP "192.168.4.1"', SRC)
        self.assertIn('#define BUTTON_PORT 5001', SRC)
        self.assertIn('#define SERVER_PORT 5000', SRC)
        self.assertIn('xQueueCreate(1, sizeof(frame_item_t))', SRC)
        self.assertIn('xQueueCreate(1, sizeof(uint8_t))', SRC)
        self.assertIn('FRAME_SEND_TIMEOUT_US', SRC)
        self.assertIn('cam_send_until(sock, &header', SRC)
        self.assertIn('cam_send_until(sock, item.fb->buf', SRC)
        self.assertIn('cam_core.c', (MAIN / 'CMakeLists.txt').read_text())
        self.assertIn('cam_io.c', (MAIN / 'CMakeLists.txt').read_text())

if __name__ == '__main__':
    unittest.main()
