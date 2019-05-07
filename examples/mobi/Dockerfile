FROM python:2.7
COPY . /app
RUN ["pip","install","docutils==0.14"]
RUN ["pip","install","Sphinx==1.4.5"]
CMD ["python","/app/mobi.py"]