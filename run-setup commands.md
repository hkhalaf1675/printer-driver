
# install pkg to create exe file
```bash
npm i -g pkg 
```

# create the exe file
```t
npx pkg . --targets node18-win-x64 --output printer-service.exe
```

# run the program
```bash
.\printer-service.exe --config "C:\Program Files\PrinterService\config.json"
```