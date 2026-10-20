"""Executable regression guards for the preserved classic ESP32-CAM wiring/wire."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]

class PreservedCameraContract(unittest.TestCase):
    def test_original_aithinker_pin_map_and_jpeg_setup(self):
        source = (ROOT / 'cam/main/main.c').read_text()
        # Values read from f7f0ea4 original CAM main BEFORE implementation.
        original = {'pwdn':32,'reset':-1,'xclk':0,'sccb_sda':26,'sccb_scl':27,
                    'd7':35,'d6':34,'d5':39,'d4':36,'d3':21,'d2':19,'d1':18,'d0':5,
                    'vsync':25,'href':23,'pclk':22}
        actual = {name:int(value) for name,value in re.findall(r'\.pin_(\w+)\s*=\s*(-?\d+)', source)}
        for name,value in original.items():
            self.assertEqual(actual[name], value, name)
        self.assertIn('.xclk_freq_hz = 20000000', source)
        self.assertIn('.pixel_format = PIXFORMAT_JPEG', source)
        self.assertIn('#define BUTTON_GPIO GPIO_NUM_13', source)
        self.assertIn('FRAMESIZE_QVGA, FRAMESIZE_VGA, FRAMESIZE_SXGA', source)
        self.assertNotIn('CAMERA_RIGHT', source)

    def test_sender_transmits_original_jpeg_and_gateway_does_not_reencode(self):
        source = (ROOT / 'cam/main/main.c').read_text()
        gateway = (ROOT / 'proxy/main/gateway.c').read_text()
        self.assertIn('cam_send_until(sock, item.fb->buf, item.fb->len, deadline', source)
        self.assertIn('receive_exact(fd,bytes+52,h.jpeg_size', gateway)
        self.assertIn('vdx_valid_jpeg(&h,bytes+52,h.jpeg_size)', gateway)
        self.assertIn('memcpy(bytes+24,&h,28)', gateway)
        self.assertNotIn('to_jpg', gateway)
        self.assertNotIn('nvs_flash_erase', gateway)

if __name__ == '__main__':
    unittest.main()
