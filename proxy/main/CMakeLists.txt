idf_component_register(SRCS "main.c" "gateway.c"
                    INCLUDE_DIRS "."
                    PRIV_REQUIRES esp_wifi esp_event esp_netif nvs_flash
                                  esp_timer esp_driver_usb_serial_jtag lwip
                                  esp_https_server esp_http_server json)
