# Android USB CDC 연결

실제 v2 작업 폴더는 `/home/minwoo/.superset/projects/videx`이다. Android Chrome에서 HTTPS 웹앱을 열고, OTG/데이터 케이블로 ESP32-S3 USB Serial/JTAG 포트에 연결한다. 다른 USB 앱이 포트를 점유하지 않도록 한다.

## 연결

1. 웹앱 새로고침 후 VIDEX 로고를 눌러 진단 및 설정을 연다.
2. 연결 방식에서 `Android USB-C · S3 CDC (WebUSB)`를 선택한다.
3. 설치된 펌웨어에 맞는 프로필을 선택한다.
   - 기존 `run_videx.py --port /dev/ttyACM0`와 사용하던 CAM2 펌웨어: `기존 Python용 CAM2 · 모드 명령/버튼 메타데이터`.
   - 현재 v2 gateway 펌웨어: `v2 gateway · 읽기 전용 미러`. NVS `usb_diag=1` 및 기존 gateway 프로비저닝이 필요하다. 이 펌웨어는 USB 명령 수신과 버튼 이벤트를 구현하지 않았으므로 고해상도 인식을 위한 모드 변경은 지원하지 않는다. 프로필 선택으로 펌웨어 기능이 추가되지는 않는다.
4. USB 연결 버튼을 누르고 Espressif USB JTAG/serial debug unit을 선택해 권한을 허용한다.
5. 장치 연결, 실제 영상 크기, 처리 프레임 증가와 보행 Worker 사유를 확인한다. 연결만 성공하고 프레임이 증가하지 않으면 CAM–S3 송신/전원/펌웨어 설정을 확인한다.
6. OCR/물체 인식은 기존 API 키와 선택 사진 전송 동의가 별도로 필요하다. 키/토큰은 채팅이나 스크린샷으로 공유하지 않는다.

## 구현과 한계

WebUSB로 CDC ACM 제어/데이터 인터페이스를 찾아 사용하며 VID/PID는 Espressif `303a:1001`로 제한한다. JTAG 인터페이스는 사용하지 않는다. USB CAM2 바이트 스트림을 증분 파싱하고 기존 브라우저 분석 경로에 전달한다. USB 영상은 Python이나 Cloudflare로 중계하지 않는다. 기존 WSS 연결 방식은 유지한다.

기존 CAM2 프로필의 모드 명령은 raw byte 0/1/2이고, 명령 전송 성공만으로 해상도가 적용됐다고 판단하지 않는다. 실제 수신 프레임 크기로 확인한다. 버튼 메타데이터는 수신된 눌림/해제 쌍에 따라 처리하므로 USB 전송에서 누락된 이벤트를 복원할 수 없다.

Android 기종의 OS 드라이버가 CDC 인터페이스를 점유하면 WebUSB가 열지 못할 수 있다. 이 경우 웹 권한 허용만으로 해결을 보장하지 않으며 네이티브 USB-host 경로 등의 별도 검토가 필요하다. WebUSB 미지원/선택 취소/열기 실패/영상 지연/분리 상태는 진단에 표시한다.

## 검증 범위

단위 테스트 45개, TypeScript 및 Vite 프로덕션 빌드, 포맷 검사 통과. 프로덕션 브라우저 E2E 7개 통과: 모의 USB 장치 경계에서 실제 CAM2 파서와 JPEG Worker 처리, 연결 버튼 사용자 제스처, 기존 모드 명령, 장치 분리 등을 검증했다.

실제 Android/S3 USB 권한, 실영상 처리량, 물리 버튼, 실제 OpenAI 호출은 미검증이다. 펌웨어 수정·플래시·커밋·푸시는 수행하지 않았다.
