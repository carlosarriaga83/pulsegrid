try:
    import ota_boot
    ota_boot.run()
except Exception as error:
    print("OTA boot recovery:", error)
