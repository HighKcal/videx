/* Firmware entry point; gateway owns the single-camera transport. */
void videx_gateway_start(void);
void app_main(void)
{
    videx_gateway_start();
}