try:
    import ota_boot
    ota_boot.run()
    import sys
    state = ota_boot._read_state()
    if not state or state.get('state') != 'applied':
        sys.modules.pop('ota_boot', None)
except Exception as error:
    print("OTA boot recovery:", error)
